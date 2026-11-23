import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rulesOf, toPlain } from '../../src/model/json.js';
import { acquireKernelLock } from '../../src/lock.js';
import { ruleRef } from '../../src/model/rules.js';
import { CURL, SAFARI, sampleModel, sampleModelText, SLACK } from '../fixtures/model.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

let harness: Harness | undefined;
const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness({ allow: ['rules', 'restore'], ...options });
  return harness;
};
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const ORIGINAL_REFS = rulesOf(sampleModel()).map(ruleRef);
const NEW_RULE = { action: 'deny', process: SLACK, remote_domains: ['Tracker.Example'], notes: 'ads' };
const refs = (h: Harness): string[] => rulesOf(h.model()).map(ruleRef);
const commands = (h: Harness): string[] => h.calls().map((call) => call[0] ?? '');
const auditLog = (h: Harness): Array<Record<string, string>> =>
  readFileSync(path.join(h.dataDir, 'changes.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, string>);

describe('add_rule', () => {
  it('adds the rule, keeps every other rule exactly as it was, and leaves a backup and a log entry', async () => {
    const h = await start();
    const { data, isError } = await h.call('add_rule', NEW_RULE);
    expect(isError).toBe(false);
    expect(data).toMatchObject({
      applied: true,
      approvedThrough: 'direct',
      rule: { action: 'deny', process: SLACK, remote: { kind: 'domains', values: ['tracker.example'] }, notes: 'ads Added through MCP on 2026-11-22.' },
    });
    expect(data.backup).toMatch(/^20261122T160000Z-before-add-rule-[0-9a-f]{6}\.json$/);

    const rules = rulesOf(h.model());
    expect(rules.map(ruleRef).slice(0, 4)).toEqual(ORIGINAL_REFS);
    expect(toPlain(rules[4])).toEqual({
      action: 'deny',
      creationDate: '2026-11-22T16:00:00Z',
      modificationDate: '2026-11-22T16:00:00Z',
      origin: 'frontend',
      uid: 501,
      process: SLACK,
      'remote-domains': 'tracker.example',
      notes: 'ads Added through MCP on 2026-11-22.',
    });
    expect(h.modelText()).toContain('"futureFlag":18446744073709551615');
    expect(h.modelText()).toContain('"lastUsed":816000000.5');

    const calls = h.calls();
    expect(calls.map((call) => call.slice(0, 2))).toEqual([['export-model'], ['restore-model', '--preserve-terminal-access'], ['export-model']]);
    expect(calls[1]?.[2]).toContain(path.join(h.dataDir, 'pending'));
    expect(readdirSync(path.join(h.dataDir, 'pending'))).toEqual([]);
    expect(readFileSync(path.join(h.dataDir, 'backups', data.backup), 'utf8')).toBe(sampleModelText());
    expect(auditLog(h)).toMatchObject([
      {
        tool: 'add_rule',
        outcome: 'applied',
        backup: data.backup,
        summary: `add rule: DENY connections to the domains tracker.example for ${SLACK}, with the note "ads Added through MCP on 2026-11-22."`,
      },
    ]);
  });

  it('changes nothing on a dry run and shows the approval prompt the person would see', async () => {
    const h = await start();
    const { data } = await h.call('add_rule', { ...NEW_RULE, dry_run: true });
    expect(data).toMatchObject({ applied: false, dryRun: true, preview: { wouldAdd: { action: 'deny', process: SLACK } } });
    expect(data.preview.approvalPrompt).toBe(
      `Little Snitch MCP wants to ADD a firewall rule: DENY connections to the domains tracker.example for ${SLACK}, with the note "ads Added through MCP on 2026-11-22.".`,
    );
    expect(commands(h)).toEqual(['export-model']);
    expect(h.modelText()).toBe(sampleModelText());
    expect((await h.call('list_backups')).data.backups).toEqual([]);
  });

  it('refuses an invalid rule before reading or changing anything', async () => {
    const h = await start();
    const broad = await h.call('add_rule', { action: 'allow', process: 'any', remote: 'any' });
    expect(broad.data.error).toMatchObject({ kind: 'invalid-input' });
    expect(broad.data.error.message).toContain('switch the firewall off');
    const noRemote = await h.call('add_rule', { action: 'deny', process: CURL });
    expect(noRemote.data.error.message).toContain('exactly one of');
    const hidden = await h.call('add_rule', { ...NEW_RULE, notes: 'looks fine‮' });
    expect(hidden.data.error.message).toContain('invisible characters');
    const tooMany = await h.call('add_rule', { action: 'deny', process: CURL, remote_hosts: Array.from({ length: 60 }, (_, index) => `host-number-${index}.example.com`) });
    expect(tooMany.data.error.message).toContain('more remotes than fit into one approval prompt');
    expect(h.calls()).toEqual([]);
  });

  it('refuses a second rule with the same meaning as an existing one', async () => {
    const h = await start();
    const { data } = await h.call('add_rule', { action: 'allow', process: SAFARI, remote_domains: ['EXAMPLE.com'] });
    expect(data.error.kind).toBe('invalid-input');
    expect(data.error.message).toContain(`ref ${ORIGINAL_REFS[0]}`);
    expect(commands(h)).toEqual(['export-model']);
  });

  it('accepts a rule Little Snitch respelled without changing what it means', async () => {
    const h = await start({ restoreBehaviors: ['respell'] });
    const { data, isError } = await h.call('add_rule', { ...NEW_RULE, protocol: 'tcp', ports: '443' });
    expect(isError).toBe(false);
    expect(data.rule).toMatchObject({ protocol: '6', ports: '443', direction: 'outgoing', remote: { kind: 'domains', values: ['tracker.example'] } });
  });

  it('reports a rule Little Snitch silently did not take, and does not restore anything', async () => {
    const h = await start({ restoreBehaviors: ['ignore'] });
    const { data, isError } = await h.call('add_rule', NEW_RULE);
    expect(isError).toBe(true);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('did not take the change');
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true });
    expect(data.error.details.notApplied).toHaveLength(1);
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h)).toMatchObject([{ outcome: 'failed' }]);
  });

  it('keeps terminal access switched on across the change', async () => {
    const h = await start();
    await h.call('add_rule', NEW_RULE);
    const { data } = await h.call('get_status');
    expect(data.terminalAccess).toBe('enabled');
  });
});

describe('add_rule when the configuration afterwards is not the intended one', () => {
  /** Each of these is undone: the earlier configuration is restored and checked. */
  const undone = async (behavior: string): Promise<{ h: Harness; error: any }> => {
    const h = await start({ restoreBehaviors: [behavior] });
    const { data, isError } = await h.call('add_rule', NEW_RULE);
    expect(isError).toBe(true);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('The earlier configuration was put back and checked');
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model', 'restore-model', 'export-model']);
    // The undo restores a fresh copy of what was read before the change, not the backup file on disk.
    expect(h.calls()[3]?.[2]).toContain(path.join(h.dataDir, 'pending'));
    expect(readdirSync(path.join(h.dataDir, 'pending'))).toEqual([]);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h)).toMatchObject([{ outcome: 'rolled-back' }]);
    return { h, error: data.error };
  };

  it('undoes the change when another rule got lost', async () => {
    const { error } = await undone('drop-first-rule');
    expect(error.details.missing.map((rule: { process: string }) => rule.process)).toEqual([SAFARI]);
    expect(error.message).toContain('1 rule(s) missing');
  });

  it('undoes the change when the rule came back with the opposite action', async () => {
    const { error } = await undone('flip-new-action');
    expect(error.details.unexpected.map((rule: { action: string }) => rule.action)).toEqual(['allow']);
    expect(error.details.notApplied).toHaveLength(1);
  });

  it('undoes the change when a rule appeared that nobody asked for', async () => {
    const { error } = await undone('add-stray-rule');
    expect(error.details.unexpected.map((rule: { remote: unknown }) => rule.remote)).toEqual([{ kind: 'domains', values: ['stray.example'] }]);
    expect(error.message).toContain('1 rule(s) nobody asked for');
  });

  it('undoes the change when the rule came back for another user', async () => {
    const { error } = await undone('change-uid');
    expect(error.details.unexpected.map((rule: { uid: number }) => rule.uid)).toEqual([0]);
  });

  it('undoes the change when the rule came back with a field nobody sent', async () => {
    const { error } = await undone('add-unknown-field');
    expect(error.details.unexpected[0].other).toEqual({ disabled: true });
  });

  it('undoes the change when a preference changed alongside', async () => {
    const { h, error } = await undone('flip-preference');
    expect(error.details.changedSections).toEqual(['globalDefaults']);
    expect(error.message).toContain('these parts differ: globalDefaults');
    expect(h.modelText()).toContain('"allowCommandLineAccess":true');
  });

  it('undoes the change when a rule group was switched alongside', async () => {
    const { error } = await undone('switch-group');
    expect(error.details.otherChanges).toEqual(['The rule group "iCloud Services" is on and should be off.']);
  });
});

describe('add_rule when things fail after the change was made', () => {
  it('reads again and undoes the change when the read-back failed', async () => {
    const h = await start({ failExportsAfterRestore: 1 });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('could not be read back');
    expect(data.error.message).toContain('The earlier configuration was put back and checked');
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true, cause: 'verification-failed' });
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model', 'export-model', 'restore-model', 'export-model']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
  });

  it('restores the backup even when the configuration cannot be read at all', async () => {
    const h = await start({ failExportsAfterRestore: 2 });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(refs(h)).toEqual(ORIGINAL_REFS);
  });

  it('says plainly when the undo itself could not be checked, with the command to restore by hand', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule', 'add-stray-rule'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('The backup was restored, but the configuration still differs from before (1 rule(s) nobody asked for)');
    expect(data.error.message).toContain('restore-model --preserve-terminal-access');
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: false });
    expect(data.error.details.afterUndo.unexpected[0].remote).toEqual({ kind: 'domains', values: ['stray.example'] });
    expect(auditLog(h)).toMatchObject([{ outcome: 'not-rolled-back' }]);
  });

  it('says plainly when the undo was refused, with the command to restore by hand', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule', 'reject'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.message).toContain('could NOT be undone automatically');
    expect(data.error.message).toContain(path.join(h.dataDir, 'backups', data.error.details.backup));
    expect(data.error.message).toMatch(/shasum -a 256 '.*' must print [0-9a-f]{64}\./);
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: false });
    expect(auditLog(h)).toMatchObject([{ outcome: 'not-rolled-back' }]);
  });

  it('checks that nothing changed when Little Snitch refused the configuration', async () => {
    const h = await start({ restoreBehaviors: ['reject'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('cli-failed');
    expect(data.error.message).toContain('the backup file is not valid');
    expect(data.error.message).toContain('is as it was before');
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true });
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model']);
    expect(h.modelText()).toBe(sampleModelText());
    expect(readdirSync(path.join(h.dataDir, 'pending'))).toEqual([]);
    expect(auditLog(h)).toMatchObject([{ outcome: 'failed', detail: 'nothing changed' }]);
  });
});

describe('several changes at once', () => {
  it('applies two rule changes asked for at the same moment one after the other, and keeps both', async () => {
    const h = await start();
    const [first, second] = await Promise.all([
      h.call('add_rule', { action: 'deny', process: SLACK, remote_hosts: ['aaa.example'] }),
      h.call('add_rule', { action: 'deny', process: SLACK, remote_hosts: ['bbb.example'] }),
    ]);
    expect(first.data.applied).toBe(true);
    expect(second.data.applied).toBe(true);
    const hosts = rulesOf(h.model()).map((rule) => toPlain(rule['remote-hosts'])).filter((value) => typeof value === 'string');
    expect(hosts).toEqual(['aaa.example', 'bbb.example']);
    expect(refs(h).slice(0, 4)).toEqual(ORIGINAL_REFS);
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model', 'export-model', 'restore-model', 'export-model']);
  });

  it('refuses a change while another server is in the middle of one', async () => {
    const h = await start();
    const release = await acquireKernelLock(h.lockFile);
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('busy');
    expect(h.calls()).toEqual([]);
    await release();
    expect((await h.call('add_rule', NEW_RULE)).data.applied).toBe(true);
  });

  it('shares one lock between servers that were started with different data folders', async () => {
    const h = await start();
    expect(h.lockFile.startsWith(h.dataDir)).toBe(false);
    expect(h.lockFile.endsWith(path.join('Library', 'Application Support', 'little-snitch-mcp-server', 'change.lock'))).toBe(true);
  });
});

describe('a change log that cannot be written', () => {
  it('does not turn an applied change into an error: the result carries a warning', async () => {
    const h = await start();
    mkdirSync(path.join(h.dataDir, 'changes.log'), { recursive: true });
    const { data, isError } = await h.call('add_rule', NEW_RULE);
    expect(isError).toBe(false);
    expect(data.applied).toBe(true);
    expect(data.warnings).toEqual(['The change is in effect and was checked, but it could not be written to the change log.']);
    expect(rulesOf(h.model())).toHaveLength(5);
  });
});

describe('update_rule', () => {
  it('changes the action of one rule and nothing else', async () => {
    const h = await start();
    const { data, isError } = await h.call('update_rule', { ref: ORIGINAL_REFS[0], action: 'deny', notes: 'blocked for now' });
    expect(isError).toBe(false);
    expect(data.rule).toMatchObject({ action: 'deny', process: SAFARI, notes: 'blocked for now', modified: '2026-11-22T16:00:00.000Z', created: '2026-01-10T09:00:00.000Z' });
    expect(data.rule.ref).not.toBe(ORIGINAL_REFS[0]);
    expect(refs(h).slice(1)).toEqual(ORIGINAL_REFS.slice(1));
    expect(rulesOf(h.model())).toHaveLength(4);
    expect(auditLog(h)[0]?.['summary']).toBe(`change rule (action ALLOW becomes DENY; the note changes): ALLOW connections to the domains example.com for ${SAFARI}`);
  });

  it('shows before, after and the approval prompt on a dry run', async () => {
    const h = await start();
    const { data } = await h.call('update_rule', { ref: ORIGINAL_REFS[3], priority: 'regular', dry_run: true });
    expect(data.preview.before.priority).toBe('high');
    expect(data.preview.after.priority).toBe('regular');
    expect(data.preview.approvalPrompt).toBe(
      `Little Snitch MCP wants to CHANGE a firewall rule (priority high becomes regular). After the change it will be: ALLOW connections to ANY remote for ${CURL} (ports 443, protocol 6).`,
    );
    expect(h.modelText()).toBe(sampleModelText());
  });

  it('refuses a protected rule, an unknown reference, and a call with nothing to change', async () => {
    const h = await start();
    expect((await h.call('update_rule', { ref: ORIGINAL_REFS[2], action: 'deny' })).data.error.kind).toBe('protected');
    expect((await h.call('update_rule', { ref: 'r000000000000', action: 'deny' })).data.error.kind).toBe('not-found');
    expect((await h.call('update_rule', { ref: ORIGINAL_REFS[0], action: 'allow' })).data.error.message).toContain('Nothing to change');
    expect(commands(h)).toEqual(['export-model', 'export-model', 'export-model']);
    const empty = await h.call('update_rule', { ref: ORIGINAL_REFS[0] });
    expect(empty.data.error.message).toContain('at least one of');
    expect(h.modelText()).toBe(sampleModelText());
  });

  it('refuses to change or remove a rule whose remotes do not fit into the approval prompt', async () => {
    const hosts = Array.from({ length: 60 }, (_, index) => `"host-number-${index}.example.com"`).join(', ');
    const h = await start({ modelText: sampleModelText().replace('"remote-hosts": ["telemetry.slack.example", "metrics.slack.example"]', `"remote-hosts": [${hosts}]`) });
    const long = rulesOf(h.model()).map(ruleRef)[1];
    const update = await h.call('update_rule', { ref: long, action: 'allow' });
    expect(update.data.error.kind).toBe('invalid-input');
    expect(update.data.error.message).toContain('Change or remove it in Little Snitch itself');
    const remove = await h.call('remove_rule', { ref: long });
    expect(remove.data.error.message).toContain('more remotes than fit into one approval prompt');
    const dry = await h.call('remove_rule', { ref: long, dry_run: true });
    expect(dry.isError).toBe(true);
    expect(commands(h)).toEqual(['export-model', 'export-model', 'export-model']);
  });

  it('names the macOS user in the prompt when the rule belongs to someone else', async () => {
    const h = await start({ modelText: sampleModelText().replace('"uid": 501,\n      "process": "/Applications/Safari.app', '"uid": 502,\n      "process": "/Applications/Safari.app') });
    const other = rulesOf(h.model()).map(ruleRef)[0];
    const { data } = await h.call('remove_rule', { ref: other, dry_run: true });
    expect(data.preview.approvalPrompt).toBe(
      `Little Snitch MCP wants to REMOVE a firewall rule: ALLOW connections to the domains example.com for ${SAFARI}, a rule of macOS user 502.`,
    );
  });

  it('puts the rule back when the changed rule vanished', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule'] });
    const { data } = await h.call('update_rule', { ref: ORIGINAL_REFS[0], action: 'deny' });
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(refs(h)).toEqual(ORIGINAL_REFS);
  });
});

describe('remove_rule and restore_backup', () => {
  it('removes one rule, and a restore of the backup brings it back', async () => {
    const h = await start();
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    expect(removed.data).toMatchObject({ applied: true, removed: { process: SLACK, action: 'deny' } });
    expect(refs(h)).toEqual([ORIGINAL_REFS[0], ORIGINAL_REFS[2], ORIGINAL_REFS[3]]);

    const preview = await h.call('restore_backup', { name: removed.data.backup, dry_run: true });
    expect(preview.data).toMatchObject({ applied: false, dryRun: true, effect: { rulesRemoved: 0, rulesAdded: 1, otherPartsChanged: [] } });
    expect(preview.data.effect.examplesAdded[0]).toMatchObject({ process: SLACK });
    expect(refs(h)).toHaveLength(3);

    const restored = await h.call('restore_backup', { name: removed.data.backup });
    expect(restored.data).toMatchObject({ applied: true, restored: removed.data.backup, rulesNow: 4 });
    expect(restored.data.savedBefore).toMatch(/before-restore-backup/);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h).map((entry) => [entry['tool'], entry['outcome']])).toEqual([['remove_rule', 'applied'], ['restore_backup', 'applied']]);
  });

  it('restores the oldest of fifty backups without pruning it away first', async () => {
    const h = await start();
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    const target = removed.data.backup as string;
    const folder = path.join(h.dataDir, 'backups');
    // Forty-nine newer backups fill the folder to its limit, so the target is the oldest of fifty.
    for (let index = 0; index < 49; index += 1) {
      copyFileSync(path.join(folder, target), path.join(folder, `20261122T1700${String(index).padStart(2, '0')}Z-filler-abcdef.json`));
    }
    expect(readdirSync(folder)).toHaveLength(50);

    const { data, isError } = await h.call('restore_backup', { name: target });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ applied: true, restored: target, rulesNow: 4 });
    // The copy saved before the restore was the fifty-first backup. The target was not the one removed for it.
    expect(existsSync(path.join(folder, target))).toBe(true);
    expect(existsSync(path.join(folder, data.savedBefore))).toBe(true);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    // Root was given a fresh copy of what was read, not the backup file itself.
    expect(h.calls().at(-2)?.[2]).toContain(path.join(h.dataDir, 'pending'));
  });

  it('refuses to remove a protected rule', async () => {
    const h = await start();
    const { data } = await h.call('remove_rule', { ref: ORIGINAL_REFS[2] });
    expect(data.error.kind).toBe('protected');
    expect(h.modelText()).toBe(sampleModelText());
  });

  it('reports a removal that did not happen', async () => {
    const h = await start({ restoreBehaviors: ['ignore'] });
    const { data } = await h.call('remove_rule', { ref: ORIGINAL_REFS[0] });
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true });
    expect(data.error.details.notRemoved.map((rule: { process: string }) => rule.process)).toEqual([SAFARI]);
  });

  it('takes a backup only by a file name this server made', async () => {
    const h = await start();
    expect((await h.call('restore_backup', { name: '../../etc/passwd' })).data.error.kind).toBe('invalid-input');
    expect((await h.call('restore_backup', { name: '20260101T000000Z-manual-abcdef.json' })).data.error.kind).toBe('not-found');
    expect(h.calls()).toEqual([]);
  });

  it('puts the configuration from before the restore back when the restore lost a rule', async () => {
    const h = await start({ restoreBehaviors: ['accept', 'drop-first-rule'] });
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    const beforeRestore = refs(h);
    const { data } = await h.call('restore_backup', { name: removed.data.backup });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('1 rule(s) missing');
    expect(data.error.message).toContain('The earlier configuration was put back and checked');
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(refs(h)).toEqual(beforeRestore);
  });

  it('puts the configuration from before the restore back when a rule appeared that the backup does not hold', async () => {
    const h = await start({ restoreBehaviors: ['accept', 'add-stray-rule'] });
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    const beforeRestore = refs(h);
    const { data, isError } = await h.call('restore_backup', { name: removed.data.backup });
    expect(isError).toBe(true);
    expect(data.error.details.unexpected[0].remote).toEqual({ kind: 'domains', values: ['stray.example'] });
    expect(data.error.details).toMatchObject({ rolledBack: true });
    expect(refs(h)).toEqual(beforeRestore);
  });
});

describe('what the owner switched off in Little Snitch itself', () => {
  it('does not add, change, remove or restore when "Allow Rule Editing" is off for this user', async () => {
    const h = await start({ modelText: sampleModelText().replace('"markNewRulesAsUnapproved": false', '"markNewRulesAsUnapproved": false, "allowRuleAndProfileEditing": false') });
    const refsNow = rulesOf(h.model()).map(ruleRef);
    for (const [tool, args] of [
      ['add_rule', NEW_RULE],
      ['update_rule', { ref: refsNow[0], action: 'deny' }],
      ['remove_rule', { ref: refsNow[0] }],
    ] as const) {
      const { data } = await h.call(tool, args);
      expect(data.error.kind).toBe('capability-disabled');
      expect(data.error.message).toContain('"Allow Rule Editing" is switched off');
    }
    expect(commands(h)).toEqual(['export-model', 'export-model', 'export-model']);
    expect(rulesOf(h.model()).map(ruleRef)).toEqual(refsNow);
  });

  it('is not held back by the switch of another macOS user', async () => {
    const h = await start({
      modelText: sampleModelText().replace('"users": [', '"users": [\n    { "uid": 502, "shortName": "other", "fullName": "Other", "defaults": { "allowRuleAndProfileEditing": false } },'),
    });
    expect((await h.call('add_rule', NEW_RULE)).data.applied).toBe(true);
  });
});

describe('rules of other macOS users', () => {
  it('does not treat another user\'s rule with the same meaning as a duplicate', async () => {
    const h = await start({ modelText: sampleModelText().replace('"uid": 501,\n      "process": "/Applications/Safari.app', '"uid": 502,\n      "process": "/Applications/Safari.app') });
    const { data, isError } = await h.call('add_rule', { action: 'allow', process: SAFARI, remote_domains: ['example.com'] });
    expect(isError).toBe(false);
    expect(data.rule).toMatchObject({ uid: 501, process: SAFARI });
    expect(rulesOf(h.model())).toHaveLength(5);
  });
});
