import { describe, expect, it } from 'vitest';
import { applyModelChange } from '../src/apply.js';
import type { ChangeResult, LittleSnitchCli } from '../src/cli/littlesnitch.js';
import type { Context } from '../src/context.js';
import { LittleSnitchError } from '../src/errors.js';
import { addRule, buildRule } from '../src/model/edit.js';
import { parseModelText, serializeModel, type JsonObject } from '../src/model/json.js';
import type { AuditEntry, BackupInfo } from '../src/store.js';
import { CURL, sampleModelText } from './fixtures/model.js';

const NOW = new Date('2026-11-22T16:00:00Z');
const BACKUP: BackupInfo = { name: 'backup.json', path: '/data/backups/backup.json', created: NOW.toISOString(), bytes: 1 };

/**
 * A context whose Little Snitch is scripted: `restores` answers each restore in
 * turn, and `reads` gives the configuration for each fresh read after the first.
 */
function scripted(options: { restores: Array<() => ChangeResult>; reads?: Array<() => string>; logWritable?: boolean; cliPath?: string }) {
  const audits: AuditEntry[] = [];
  const restoredFiles: string[] = [];
  const restores = [...options.restores];
  const reads = [() => sampleModelText(), ...(options.reads ?? [])];
  let cached: JsonObject | undefined;
  const cli = {
    restoreModel: async (file: string) => {
      restoredFiles.push(file);
      const next = restores.shift();
      if (next === undefined) {
        throw new Error('unexpected restore');
      }
      return next();
    },
  } as unknown as LittleSnitchCli;
  const ctx = {
    config: { cliPath: options.cliPath ?? '/fake/littlesnitch' },
    cli,
    changes: { run: <T>(change: () => Promise<T>) => change() },
    models: {
      fresh: async () => {
        const read = reads.shift();
        if (read === undefined) {
          throw new Error('unexpected read');
        }
        const text = read();
        cached = parseModelText(text);
        return { model: cached, text };
      },
      get: async () => cached ?? {},
      put: (model: JsonObject) => {
        cached = model;
      },
      clear: () => {
        cached = undefined;
      },
    },
    store: {
      writeBackup: async () => BACKUP,
      writePending: async () => '/data/pending/change.json',
      removePending: async () => undefined,
      audit: async (entry: AuditEntry) => {
        audits.push(entry);
        return options.logWritable ?? true;
      },
    },
    now: () => NOW,
    uid: 501,
  } as unknown as Context;
  return { ctx, audits, restoredFiles };
}

const plan = (before: JsonObject) => {
  const rule = buildRule({ action: 'deny', process: CURL, remoteDomains: ['tracker.example'] }, { uid: 501, now: NOW, model: before });
  return { tool: 'add_rule', summary: 'add', prompt: 'Approve?', next: addRule(before, rule), written: [rule], removedRefs: [], preview: {} };
};
const changedText = (): string => serializeModel(plan(parseModelText(sampleModelText())).next);
const timeout = (): never => {
  throw new LittleSnitchError('timeout', 'the administrator dialog did not finish in time.');
};

describe('applyModelChange when the change step times out', () => {
  it('starts nothing further, because the command may still be running as root, and says the state is not known', async () => {
    const { ctx, audits, restoredFiles } = scripted({ restores: [timeout] });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error).toBeInstanceOf(LittleSnitchError);
    expect(error.kind).toBe('verification-failed');
    expect(error.message).toContain('may still be running as root');
    expect(error.message).toContain('does not know whether the change is in effect');
    expect(error.message).toContain("sudo '/fake/littlesnitch' restore-model --preserve-terminal-access '/data/backups/backup.json'");
    expect(error.details).toMatchObject({ rolledBack: false, configurationAsBefore: 'unknown', cause: 'timeout' });
    // One restore was started. No second restore and no further read followed.
    expect(restoredFiles).toEqual(['/data/pending/change.json']);
    expect(audits).toMatchObject([{ outcome: 'not-rolled-back', detail: 'timeout, state unknown' }]);
  });
});

describe('applyModelChange when a step fails after the change may have run', () => {
  const failed = (): never => {
    throw new LittleSnitchError('verification-failed', 'Little Snitch accepted the request, but its configuration could not be read back to check it.');
  };

  it('finds that nothing changed and says so', async () => {
    const { ctx, audits, restoredFiles } = scripted({ restores: [failed], reads: [() => sampleModelText()] });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.message).toContain('is as it was before, so nothing needs to be undone');
    expect(error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true, cause: 'verification-failed' });
    expect(restoredFiles).toEqual(['/data/pending/change.json']);
    expect(audits).toMatchObject([{ outcome: 'failed', detail: 'nothing changed' }]);
  });

  it('finds that the change went through and undoes it', async () => {
    const { ctx, audits, restoredFiles } = scripted({
      restores: [failed, () => ({ modelText: sampleModelText(), method: 'dialog' })],
      reads: [changedText],
    });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.kind).toBe('verification-failed');
    expect(error.message).toContain('The earlier configuration was put back and checked');
    expect(error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    // Both the change and the undo are restored from files written afresh, never from the backup on disk.
    expect(restoredFiles).toEqual(['/data/pending/change.json', '/data/pending/change.json']);
    expect(audits).toMatchObject([{ outcome: 'rolled-back' }]);
  });

  it('gives a shell-quoted command to restore by hand when the undo cannot be read back either', async () => {
    const { ctx, audits } = scripted({
      restores: [failed, () => ({ modelText: 'not json', method: 'dialog' })],
      reads: [changedText],
      cliPath: '/odd path/$(touch pwned)/little`snitch',
    });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.message).toContain('the configuration could not be read afterwards');
    expect(error.message).toContain("sudo '/odd path/$(touch pwned)/little`snitch' restore-model --preserve-terminal-access '/data/backups/backup.json'");
    expect(error.message).toMatch(/shasum -a 256 '\/data\/backups\/backup\.json' must print [0-9a-f]{64}\./);
    expect(error.details).toMatchObject({ rolledBack: false, configurationAsBefore: false });
    expect(audits).toMatchObject([{ outcome: 'not-rolled-back' }]);
  });
});

describe('applyModelChange when the change log cannot be written', () => {
  it('still reports the change as applied, with a warning', async () => {
    const { ctx } = scripted({ restores: [() => ({ modelText: changedText(), method: 'dialog' })], logWritable: false });
    const outcome = await applyModelChange(ctx, plan, false);
    expect(outcome).toMatchObject({ applied: true, warnings: ['The change is in effect and was checked, but it could not be written to the change log.'] });
  });

  it('still gives the recovery instructions when an undo fails', async () => {
    const { ctx } = scripted({ restores: [() => ({ modelText: 'garbage', method: 'dialog' }), () => ({ modelText: 'still garbage', method: 'dialog' })], reads: [changedText], logWritable: false });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.kind).toBe('verification-failed');
    expect(error.message).toContain('restore-model --preserve-terminal-access');
  });
});

describe('applyModelChange when nothing was run', () => {
  it('passes a cancelled approval on without reading or restoring anything else', async () => {
    const cancelled = (): never => {
      throw new LittleSnitchError('elevation-cancelled', 'The administrator dialog was cancelled, so nothing was run.');
    };
    const { ctx, audits, restoredFiles } = scripted({ restores: [cancelled] });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.kind).toBe('elevation-cancelled');
    expect(restoredFiles).toHaveLength(1);
    expect(audits).toMatchObject([{ outcome: 'failed', detail: 'elevation-cancelled' }]);
  });

  it('passes a file that was swapped before the run on as tampered', async () => {
    const tampered = (): never => {
      throw new LittleSnitchError('tampered', 'The file to restore is not the file that was written. Nothing was run.');
    };
    const { ctx } = scripted({ restores: [tampered] });
    await expect(applyModelChange(ctx, plan, false)).rejects.toMatchObject({ kind: 'tampered' });
  });
});

describe('applyModelChange when the read-back is not a configuration', () => {
  it('treats it as unknown, reads again and undoes the change', async () => {
    const { ctx } = scripted({
      restores: [() => ({ modelText: 'garbage', method: 'dialog' }), () => ({ modelText: sampleModelText(), method: 'dialog' })],
      reads: [changedText],
    });
    const error = (await applyModelChange(ctx, plan, false).catch((caught: unknown) => caught)) as LittleSnitchError;
    expect(error.kind).toBe('verification-failed');
    expect(error.details).toMatchObject({ rolledBack: true, cause: 'unexpected-output' });
  });
});
