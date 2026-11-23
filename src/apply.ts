import { prompts } from './approval.js';
import { shellQuote } from './cli/shell.js';
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
  /** Things the person should know that were found while planning. They go into the result. */
  readonly warnings?: readonly string[];
}

/** What is needed to get back to the configuration from before a change. */
export interface RecoveryRequest {
  readonly tool: string;
  readonly summary: string;
  /** The configuration read just before, and the backup file that holds it. */
  readonly before: JsonObject;
  readonly beforeText: string;
  readonly backup: BackupInfo;
}

export interface RestoreRequest extends RecoveryRequest {
  readonly prompt: string;
  /** The file to restore, and the checksum of the content that is meant. */
  readonly file: string;
  readonly fileSha256: string;
  /** What the configuration must be afterwards. */
  readonly expected: JsonObject;
  readonly written?: readonly JsonObject[];
  readonly removedRefs?: readonly string[];
}

export interface Restored {
  readonly after: JsonObject;
  readonly method: string;
  /** Things that went wrong after the change was made and checked, such as a change log that could not be written. */
  readonly warnings: readonly string[];
  /** Parts Little Snitch keeps for itself that came back different. They are not compared, only reported. */
  readonly rewrittenByLittleSnitch: readonly string[];
}

export interface AppliedChange extends Restored {
  readonly applied: true;
  readonly backup: string;
}

export type ChangeOutcome = AppliedChange | { readonly applied: false; readonly dryRun: true; readonly preview: unknown };

export const NOT_LOGGED = 'The change is in effect and was checked, but it could not be written to the change log.';
export const NOT_CLEARED =
  'The change is in effect and was checked, but the temporary copy of the configuration in the data folder (pending) could not be removed. It is removed before the next change.';

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

/**
 * How to restore by hand. Every path is quoted for the shell, since the person
 * will paste this into a terminal. The checksum lets them see that the backup
 * file is still the one this server wrote.
 */
export const manualRestore = (ctx: Context, request: RecoveryRequest): string =>
  `To put the earlier configuration back yourself, first check the backup: the command shasum -a 256 ${shellQuote(request.backup.path)} must print ${sha256(request.beforeText)}. ` +
  `Then run: sudo ${shellQuote(ctx.config.cliPath)} restore-model --preserve-terminal-access ${shellQuote(request.backup.path)}`;

export interface Recovery {
  /** True when the configuration was read and equals the one from before the change. */
  readonly asBefore: boolean;
  readonly rolledBack: boolean;
  readonly sentence: string;
  readonly details: Record<string, unknown>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isTimeout = (error: unknown): boolean => error instanceof LittleSnitchError && error.kind === 'timeout';

/**
 * Stops right before a command that changes Little Snitch when the change lock
 * is gone. Nothing of that command has run at this point.
 */
export async function requireLock(ctx: Context, request: Pick<RecoveryRequest, 'tool' | 'summary' | 'backup'>): Promise<void> {
  try {
    ctx.changes.assertLockHeld();
  } catch (error) {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: 'lock lost, nothing run' });
    throw error;
  }
}

/** Restores the configuration from before the change and checks the whole configuration against what it was. */
export async function undo(ctx: Context, request: RecoveryRequest): Promise<Recovery> {
  const fail = async (sentence: string, details: Record<string, unknown>): Promise<Recovery> => {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'not-rolled-back', backup: request.backup.name });
    return { asBefore: false, rolledBack: false, sentence: `${sentence} ${manualRestore(ctx, request)}`, details };
  };
  try {
    ctx.changes.assertLockHeld();
  } catch (error) {
    // Another change may be running now. A restore on top of it could wipe it out.
    return fail(`It was NOT undone: ${messageOf(error)}`, { lockLost: true });
  }
  // The undo restores what this server read before the change, written out afresh from memory.
  // It does not depend on the backup file still being what it was.
  let undoneText: string;
  let file: string | undefined;
  try {
    file = await ctx.store.writePending(request.beforeText);
    undoneText = (await ctx.cli.restoreModel(file, sha256(request.beforeText), prompts.undo)).modelText;
  } catch (error) {
    if (isTimeout(error)) {
      // The undo itself may still be running as root. Nothing more is started, here or by a later change.
      ctx.changes.commandMayStillRun();
      return fail(`The undo did not end in time (${messageOf(error)}), so it is not known whether the earlier configuration is back. Wait a minute, then look at the configuration.`, {
        configurationAsBefore: 'unknown',
      });
    }
    return fail(`It could NOT be undone automatically (${messageOf(error)}).`, {});
  } finally {
    if (file !== undefined && !ctx.changes.waitingForCommand()) {
      await ctx.store.removePending(file);
    }
  }
  let check;
  try {
    check = compareModels(request.before, parseModelText(undoneText));
  } catch (error) {
    return fail(`The backup was restored, but the configuration could not be read afterwards (${messageOf(error)}).`, {});
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
    sentence: 'The earlier configuration was put back and checked: every rule, rule group, profile and preference is as it was before.',
    details: {},
  };
}

/** After a failure that may have left a change behind: reads the configuration again and undoes whatever differs. */
async function recover(ctx: Context, request: RecoveryRequest): Promise<Recovery> {
  try {
    ctx.models.clear();
    const { model } = await ctx.models.fresh();
    if (compareModels(request.before, model).ok) {
      await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: 'nothing changed' });
      return {
        asBefore: true,
        rolledBack: false,
        sentence: 'The configuration was read again: every rule, rule group, profile and preference is as it was before, so nothing needs to be undone.',
        details: {},
      };
    }
  } catch {
    // The configuration could not be read. Restoring the backup is the one way left to reach a known state.
  }
  return undo(ctx, request);
}

export function recoveryDetails(request: RecoveryRequest, recovery: Recovery, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, backup: request.backup.name, rolledBack: recovery.rolledBack, configurationAsBefore: recovery.asBefore, ...recovery.details };
}

/**
 * Turns a failure of the step that changes Little Snitch into the error to report,
 * after doing what can safely be done about it. There are three cases:
 *
 * - Nothing was started (a cancelled prompt, a refused file): the error is passed on.
 * - The step timed out: the command may still be running as root, and a second
 *   command on top of it could collide with it. So nothing more is started for
 *   this change, the change queue is told to keep the lock and to refuse every
 *   later change until the command is gone, and the error says that the state
 *   is not known and how to restore by hand.
 * - Anything else: the configuration is read again and, if it differs, undone.
 */
export async function failAfterWrite(ctx: Context, request: RecoveryRequest, error: unknown): Promise<never> {
  const kind: ErrorKind | 'internal' = error instanceof LittleSnitchError ? error.kind : 'internal';
  const message = messageOf(error);
  if (error instanceof LittleSnitchError && NOTHING_RAN.includes(error.kind)) {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: kind });
    throw error;
  }
  if (kind === 'timeout') {
    ctx.changes.commandMayStillRun();
    ctx.models.clear();
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'not-rolled-back', backup: request.backup.name, detail: 'timeout, state unknown' });
    throw new LittleSnitchError(
      'verification-failed',
      `${message} The command that was started may still be running as root, so this server did not start a restore on top of it, and it does not know whether the change is in effect. ` +
        'It makes no further change for at least a minute, and none while that command is still running. ' +
        `Then look at the configuration again. ${manualRestore(ctx, request)}`,
      { details: { backup: request.backup.name, rolledBack: false, configurationAsBefore: 'unknown', cause: kind } },
    );
  }
  const recovery = await recover(ctx, request);
  throw new LittleSnitchError(
    recovery.asBefore && !recovery.rolledBack && error instanceof LittleSnitchError ? error.kind : 'verification-failed',
    `${message} ${recovery.sentence}`,
    { details: recoveryDetails(request, recovery, { cause: kind }) },
  );
}

/**
 * Restores a configuration file and proves the result. Every way this can go
 * wrong ends in one of four reported states: the configuration is as intended,
 * it is as it was before, it could not be brought back, or (after a timeout) it
 * is not known. The last two come with the command to restore by hand.
 */
export async function restoreVerified(ctx: Context, request: RestoreRequest): Promise<Restored> {
  await requireLock(ctx, request);
  ctx.models.clear();
  let restored: { readonly modelText: string; readonly method: string };
  let after: JsonObject;
  try {
    restored = await ctx.cli.restoreModel(request.file, request.fileSha256, request.prompt);
    after = parseModelText(restored.modelText);
  } catch (error) {
    return failAfterWrite(ctx, request, error);
  }

  const comparison = compareModels(request.expected, after, {
    ...(request.written === undefined ? {} : { written: request.written }),
    ...(request.removedRefs === undefined ? {} : { removedRefs: request.removedRefs }),
  });
  if (comparison.ok) {
    ctx.models.put(after);
    const logged = await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'applied', method: restored.method, backup: request.backup.name });
    return { after, method: restored.method, warnings: logged ? [] : [NOT_LOGGED], rewrittenByLittleSnitch: comparison.rewrittenByLittleSnitch };
  }

  const problem = comparisonDetails(comparison);
  if (compareModels(request.before, after).ok) {
    await ctx.store.audit({ tool: request.tool, summary: request.summary, outcome: 'failed', backup: request.backup.name, detail: 'not accepted, nothing changed' });
    throw new LittleSnitchError(
      'verification-failed',
      'Little Snitch did not take the change: every rule, rule group, profile and preference is the same as before. Nothing needs to be undone.',
      { details: { ...problem, backup: request.backup.name, rolledBack: false, configurationAsBefore: true } },
    );
  }
  const recovery = await undo(ctx, request);
  throw new LittleSnitchError(
    'verification-failed',
    `The configuration after the change is not what was intended (${describeComparison(comparison)}). ${recovery.sentence}`,
    { details: recoveryDetails(request, recovery, problem) },
  );
}

/**
 * Writes `text` to a file of its own, restores it and proves the result. The
 * file is removed afterwards, except after a timeout: then the command may
 * still be reading it, and it stays until the next change clears the folder.
 */
export async function restoreText(ctx: Context, text: string, request: Omit<RestoreRequest, 'file' | 'fileSha256'>): Promise<Restored> {
  const pending = await ctx.store.writePending(text);
  let restored: Restored;
  try {
    restored = await restoreVerified(ctx, { ...request, file: pending, fileSha256: sha256(text) });
  } catch (error) {
    if (!ctx.changes.waitingForCommand()) {
      await ctx.store.removePending(pending);
    }
    throw error;
  }
  const cleared = await ctx.store.removePending(pending);
  return cleared ? restored : { ...restored, warnings: [...restored.warnings, NOT_CLEARED] };
}

/**
 * The only way this server changes rules. Little Snitch has no command to edit
 * one rule; its documented route is to export the configuration, change it and
 * restore it. So, one change at a time: read the configuration, work out the
 * change, save a backup, restore the changed configuration, read it back, and
 * check that every rule, rule group, profile and preference is exactly the
 * intended one. If it is not, the earlier configuration is restored and
 * checked in the same way.
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
    const restored = await restoreText(ctx, serializeModel(change.next), {
      tool: change.tool,
      summary: change.summary,
      prompt: change.prompt,
      before,
      beforeText,
      backup,
      expected: change.next,
      written: change.written,
      removedRefs: change.removedRefs,
    });
    return { applied: true as const, ...restored, backup: backup.name, warnings: [...(change.warnings ?? []), ...restored.warnings] };
  });
}
