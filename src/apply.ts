import { prompts } from './approval.js';
import type { Context } from './context.js';
import { LittleSnitchError, type ErrorKind } from './errors.js';
import { parseModelText, serializeModel, sha256, type JsonObject } from './model/json.js';
import { compareModels, comparisonDetails, describeComparison } from './model/verify.js';
import type { BackupInfo } from './store.js';

export interface PlannedChange {
  readonly tool: string;
  /** One line for the change log. */
  readonly summary: string;
  /** The text of the approval prompt. Built from the rule's fields, see approval.ts. */
  readonly prompt: string;
  /** The whole configuration as it should be afterwards. */
  readonly next: JsonObject;
  /** The rules in `next` that this change writes: a new rule, or the new form of a changed one. */
  readonly written: readonly JsonObject[];
  readonly removedRefs: readonly string[];
  /** What a dry run returns. */
  readonly preview: unknown;
}

export interface RestoreRequest {
  readonly tool: string;
  readonly summary: string;
  readonly prompt: string;
  /** The configuration read just before, and the backup file that holds it. */
  readonly before: JsonObject;
  readonly beforeText: string;
  readonly backup: BackupInfo;
  /** The file to restore, and the checksum of the content that is meant. */
  readonly file: string;
  readonly fileSha256: string;
  /** What the configuration must be afterwards. */
  readonly expected: JsonObject;
  readonly written?: readonly JsonObject[];
  readonly removedRefs?: readonly string[];
}

export interface AppliedChange {
  readonly applied: true;
  readonly after: JsonObject;
  readonly backup: string;
  readonly method: string;
}

export type ChangeOutcome = AppliedChange | { readonly applied: false; readonly dryRun: true; readonly preview: unknown };

/** Errors that are raised before the tool was started, so the configuration cannot have changed. */
const NOTHING_RAN: readonly ErrorKind[] = [
  'elevation-cancelled',
  'elevation-unavailable',
  'untrusted-binary',
  'not-installed',
  'invalid-input',
  'terminal-access-disabled',
  'needs-root',
  'tampered',
];

/** How to restore by hand. The checksum lets the person see that the backup file is still the one this server wrote. */
const manualRestore = (ctx: Context, request: RestoreRequest): string =>
  `To put the earlier configuration back yourself, first check the backup: shasum -a 256 "${request.backup.path}" must print ${sha256(request.beforeText)}. ` +
  `Then run: sudo "${ctx.config.cliPath}" restore-model --preserve-terminal-access "${request.backup.path}"`;

interface Recovery {
  /** True when the configuration was read and equals the one from before the change. */
  readonly asBefore: boolean;
  readonly rolledBack: boolean;
  readonly sentence: string;
  readonly details: Record<string, unknown>;
}

/** Restores the backup from before the change and checks the whole configuration against what it was. */
async function undo(ctx: Context, request: RestoreRequest): Promise<Recovery> {
  const fail = async (sentence: string, details: Record<string, unknown>): Promise<Recovery> => {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'not-rolled-back', backup: request.backup.name });
    return { asBefore: false, rolledBack: false, sentence: `${sentence} ${manualRestore(ctx, request)}`, details };
  };
  // The undo restores what this server read before the change, written out afresh from memory.
  // It does not depend on the backup file still being what it was.
  let undoneText: string;
  let file: string | undefined;
  try {
    file = await ctx.store.writePending(request.beforeText);
    undoneText = (await ctx.cli.restoreModel(file, sha256(request.beforeText), prompts.undo)).modelText;
  } catch (error) {
    return fail(`It could NOT be undone automatically (${error instanceof Error ? error.message : String(error)}).`, {});
  } finally {
    if (file !== undefined) {
      await ctx.store.removePending(file);
    }
  }
  let check;
  try {
    check = compareModels(request.before, parseModelText(undoneText));
  } catch (error) {
    return fail(`The backup was restored, but the configuration could not be read afterwards (${error instanceof Error ? error.message : String(error)}).`, {});
  }
  if (!check.ok) {
    return fail(`The backup was restored, but the configuration still differs from before (${describeComparison(check)}).`, {
      afterUndo: comparisonDetails(check),
    });
  }
  await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'rolled-back', backup: request.backup.name });
  return {
    asBefore: true,
    rolledBack: true,
    sentence: 'The earlier configuration was put back and checked: it is as it was before.',
    details: {},
  };
}

/** After a failure that may have left a change behind: reads the configuration again and undoes whatever differs. */
async function recover(ctx: Context, request: RestoreRequest): Promise<Recovery> {
  try {
    ctx.models.clear();
    const { model } = await ctx.models.fresh();
    if (compareModels(request.before, model).ok) {
      await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: 'nothing changed' });
      return { asBefore: true, rolledBack: false, sentence: 'The configuration was read again and is as it was before, so nothing needs to be undone.', details: {} };
    }
  } catch {
    // The configuration could not be read. Restoring the backup is the one way left to reach a known state.
  }
  return undo(ctx, request);
}

/**
 * Restores a configuration file and proves the result. Every way this can go
 * wrong ends in one of three reported states: the configuration is as
 * intended, it is as it was before, or it could not be brought back and the
 * error says how to do that by hand.
 */
export async function restoreVerified(ctx: Context, request: RestoreRequest): Promise<{ readonly after: JsonObject; readonly method: string }> {
  ctx.models.clear();
  const details = (recovery: Recovery, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...extra,
    ...recovery.details,
    backup: request.backup.name,
    rolledBack: recovery.rolledBack,
    configurationAsBefore: recovery.asBefore,
  });

  let restored: { readonly modelText: string; readonly method: string };
  let after: JsonObject;
  try {
    restored = await ctx.cli.restoreModel(request.file, request.fileSha256, request.prompt);
    after = parseModelText(restored.modelText);
  } catch (error) {
    const kind: ErrorKind | 'internal' = error instanceof LittleSnitchError ? error.kind : 'internal';
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LittleSnitchError && NOTHING_RAN.includes(error.kind)) {
      await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: kind });
      throw error;
    }
    // The tool was started. Whether it changed anything is not known until the configuration is read again.
    const recovery = await recover(ctx, request);
    throw new LittleSnitchError(
      recovery.asBefore && !recovery.rolledBack && error instanceof LittleSnitchError ? error.kind : 'verification-failed',
      `${message} ${recovery.sentence}`,
      { details: details(recovery, { cause: kind }) },
    );
  }

  const comparison = compareModels(request.expected, after, {
    ...(request.written === undefined ? {} : { written: request.written }),
    ...(request.removedRefs === undefined ? {} : { removedRefs: request.removedRefs }),
  });
  if (comparison.ok) {
    ctx.models.put(after);
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'applied', method: restored.method, backup: request.backup.name });
    return { after, method: restored.method };
  }

  const problem = comparisonDetails(comparison);
  if (compareModels(request.before, after).ok) {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: 'not accepted, nothing changed' });
    throw new LittleSnitchError(
      'verification-failed',
      'Little Snitch did not take the change: the configuration is the same as before. Nothing needs to be undone.',
      { details: { ...problem, backup: request.backup.name, rolledBack: false, configurationAsBefore: true } },
    );
  }
  const recovery = await undo(ctx, request);
  throw new LittleSnitchError(
    'verification-failed',
    `The configuration after the change is not what was intended (${describeComparison(comparison)}). ${recovery.sentence}`,
    { details: details(recovery, problem) },
  );
}

/**
 * The only way this server changes rules. Little Snitch has no command to edit
 * one rule; its documented route is to export the configuration, change it and
 * restore it. So, one change at a time: read the configuration, work out the
 * change, save a backup, restore the changed configuration, read it back, and
 * check that the whole configuration is exactly the intended one. If it is
 * not, the backup is restored and checked in the same way.
 */
export async function applyModelChange(ctx: Context, plan: (before: JsonObject) => PlannedChange, dryRun: boolean): Promise<ChangeOutcome> {
  if (dryRun) {
    const { model } = await ctx.models.fresh();
    return { applied: false, dryRun: true, preview: plan(model).preview };
  }
  return ctx.changes.run(async () => {
    const { model: before, text: beforeText } = await ctx.models.fresh();
    const change = plan(before);
    const backup = await ctx.store.writeBackup(beforeText, `before-${change.tool}`);
    const nextText = serializeModel(change.next);
    const pending = await ctx.store.writePending(nextText);
    try {
      const { after, method } = await restoreVerified(ctx, {
        tool: change.tool,
        summary: change.summary,
        prompt: change.prompt,
        before,
        beforeText,
        backup,
        file: pending,
        fileSha256: sha256(nextText),
        expected: change.next,
        written: change.written,
        removedRefs: change.removedRefs,
      });
      return { applied: true as const, after, backup: backup.name, method };
    } finally {
      await ctx.store.removePending(pending);
    }
  });
}
