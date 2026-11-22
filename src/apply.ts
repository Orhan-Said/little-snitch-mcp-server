import type { Context } from './context.js';
import { LittleSnitchError } from './errors.js';
import { parseModelText, serializeModel, type JsonObject } from './model/json.js';
import { verifyChange, type Expectation, type Verification } from './model/verify.js';

export interface PlannedChange {
  readonly tool: string;
  /** One line saying what will change. Shown in the approval prompt and written to the change log. */
  readonly summary: string;
  readonly next: JsonObject;
  readonly expectation: Expectation;
  /** What a dry run returns. */
  readonly preview: unknown;
}

export interface AppliedChange {
  readonly applied: true;
  readonly after: JsonObject;
  readonly backup: string;
  readonly method: string;
  readonly notes: readonly string[];
}

export type ChangeOutcome = AppliedChange | { readonly applied: false; readonly dryRun: true; readonly preview: unknown };

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 240);

function notesFrom(verification: Verification): readonly string[] {
  return [
    ...verification.unexpected.map(
      (rule) => `A rule for ${rule.process ?? 'an unknown process'} appeared during the change and was left alone; it was not part of this request.`,
    ),
    ...verification.otherChanges,
  ];
}

const manualRestore = (ctx: Context, backup: string): string =>
  `To put the earlier configuration back yourself, run: sudo "${ctx.config.cliPath}" restore-model --preserve-terminal-access "${backup}"`;

/**
 * The only way this server changes rules. Little Snitch has no command to edit
 * one rule; its documented route is to export the configuration, change it and
 * restore it. So, in order: read the configuration, work out the change, save a
 * backup, restore the changed configuration, read it back, and check that
 * exactly the intended change happened. If it did not, the backup is restored.
 */
export async function applyModelChange(
  ctx: Context,
  plan: (before: JsonObject) => PlannedChange,
  dryRun: boolean,
): Promise<ChangeOutcome> {
  const { model: before, text: beforeText } = await ctx.models.fresh();
  const change = plan(before);
  if (dryRun) {
    return { applied: false, dryRun: true, preview: change.preview };
  }

  const backup = await ctx.store.writeBackup(beforeText, `before-${change.tool}`);
  const pending = await ctx.store.writePending(serializeModel(change.next));
  ctx.models.clear();

  let restored: { modelText: string; method: string };
  try {
    restored = await ctx.cli.restoreModel(pending, oneLine(`Little Snitch MCP wants to change your Little Snitch rules: ${change.summary}`));
  } catch (error) {
    const kind = error instanceof LittleSnitchError ? error.kind : 'internal';
    await ctx.store.audit({ tool: change.tool, summary: change.summary, outcome: 'failed', backup: backup.name, detail: kind });
    if (error instanceof LittleSnitchError && error.kind === 'verification-failed') {
      throw new LittleSnitchError('verification-failed', `${error.message} The change may be in effect. ${manualRestore(ctx, backup.path)}`, {
        details: { ...error.details, backup: backup.name },
      });
    }
    throw error;
  } finally {
    await ctx.store.removePending(pending);
  }

  const after = parseModelText(restored.modelText);
  const verification = verifyChange(before, after, change.expectation);
  if (verification.ok) {
    ctx.models.put(after);
    await ctx.store.audit({ tool: change.tool, summary: change.summary, outcome: 'applied', method: restored.method, backup: backup.name });
    return { applied: true, after, backup: backup.name, method: restored.method, notes: notesFrom(verification) };
  }

  const problem = {
    missing: verification.missing,
    notApplied: verification.notApplied,
    notRemoved: verification.notRemoved,
    unexpected: verification.unexpected,
    backup: backup.name,
  };
  if (!verification.shouldRollBack) {
    await ctx.store.audit({ tool: change.tool, summary: change.summary, outcome: 'failed', backup: backup.name, detail: 'not accepted, nothing changed' });
    throw new LittleSnitchError(
      'verification-failed',
      'Little Snitch did not take the change: the rules are the same as before. Nothing needs to be undone.',
      { details: { ...problem, rolledBack: false, rulesChanged: false } },
    );
  }

  let strayAfterUndo: Verification['unexpected'] = [];
  try {
    const undone = await ctx.cli.restoreModel(backup.path, 'Little Snitch MCP wants to undo a rule change that did not apply cleanly.');
    const check = verifyChange(before, parseModelText(undone.modelText), { removedRefs: [], added: [] });
    if (check.missing.length > 0) {
      throw new LittleSnitchError('verification-failed', 'The backup was restored but rules are still missing.');
    }
    strayAfterUndo = check.unexpected;
  } catch (error) {
    await ctx.store.audit({ tool: change.tool, summary: change.summary, outcome: 'not-rolled-back', backup: backup.name });
    throw new LittleSnitchError(
      'verification-failed',
      `The change did not apply cleanly and could NOT be undone automatically (${error instanceof Error ? error.message : String(error)}). ` +
        manualRestore(ctx, backup.path),
      { details: { ...problem, rolledBack: false, rulesChanged: true } },
    );
  }
  await ctx.store.audit({ tool: change.tool, summary: change.summary, outcome: 'rolled-back', backup: backup.name });
  if (strayAfterUndo.length > 0) {
    // Every earlier rule is back, but rules exist that were not there before: made in Little Snitch meanwhile, or the backup file was altered.
    throw new LittleSnitchError(
      'verification-failed',
      `The change did not apply cleanly and the earlier configuration was put back, but ${strayAfterUndo.length} rule(s) are present that were not there before. Check them in Little Snitch.`,
      { details: { ...problem, rolledBack: true, rulesChanged: true, presentAfterUndo: strayAfterUndo.slice(0, 20) } },
    );
  }
  throw new LittleSnitchError(
    'verification-failed',
    'The change did not apply cleanly, so the earlier configuration was put back. The rules are as they were before.',
    { details: { ...problem, rolledBack: true, rulesChanged: false } },
  );
}
