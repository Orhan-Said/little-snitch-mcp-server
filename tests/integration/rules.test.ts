import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rulesOf, toPlain } from '../../src/model/json.js';
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
    expect(auditLog(h)).toMatchObject([{ tool: 'add_rule', outcome: 'applied', backup: data.backup, summary: `add rule: deny ${SLACK} to domains: tracker.example` }]);
  });

  it('changes nothing on a dry run', async () => {
    const h = await start();
    const { data } = await h.call('add_rule', { ...NEW_RULE, dry_run: true });
    expect(data).toMatchObject({ applied: false, dryRun: true, preview: { wouldAdd: { action: 'deny', process: SLACK } } });
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
    expect(h.calls()).toEqual([]);
  });

  it('refuses a second rule with the same meaning as an existing one', async () => {
    const h = await start();
    const { data } = await h.call('add_rule', { action: 'allow', process: SAFARI, remote_domains: ['EXAMPLE.com'] });
    expect(data.error.kind).toBe('invalid-input');
    expect(data.error.message).toContain(`ref ${ORIGINAL_REFS[0]}`);
    expect(commands(h)).toEqual(['export-model']);
  });

  it('accepts a rule Little Snitch respelled on the way in', async () => {
    const h = await start({ restoreBehaviors: ['respell'] });
    const { data, isError } = await h.call('add_rule', { ...NEW_RULE, protocol: 'tcp', ports: '443' });
    expect(isError).toBe(false);
    expect(data.rule).toMatchObject({ protocol: '6', ports: '443', direction: 'outgoing', other: { approved: true } });
  });

  it('reports a rule Little Snitch silently did not take, and does not restore anything', async () => {
    const h = await start({ restoreBehaviors: ['ignore'] });
    const { data, isError } = await h.call('add_rule', NEW_RULE);
    expect(isError).toBe(true);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.details).toMatchObject({ rolledBack: false, rulesChanged: false });
    expect(data.error.details.notApplied).toHaveLength(1);
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h)).toMatchObject([{ outcome: 'failed' }]);
  });

  it('puts the earlier configuration back when another rule got lost', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.details).toMatchObject({ rolledBack: true, rulesChanged: false });
    expect(data.error.details.missing.map((rule: { process: string }) => rule.process)).toEqual([SAFARI]);
    expect(commands(h)).toEqual(['export-model', 'restore-model', 'export-model', 'restore-model', 'export-model']);
    expect(h.calls()[3]?.[2]).toBe(path.join(h.dataDir, 'backups', data.error.details.backup));
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h)).toMatchObject([{ outcome: 'rolled-back' }]);
  });

  it('puts the earlier configuration back when the rule came back with the opposite action', async () => {
    const h = await start({ restoreBehaviors: ['flip-new-action'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.details).toMatchObject({ rolledBack: true });
    expect(data.error.details.unexpected.map((rule: { action: string }) => rule.action)).toEqual(['allow']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
  });

  it('reports rules that are present after an undo and were not there before', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule', 'add-stray-rule'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('1 rule(s) are present that were not there before');
    expect(data.error.details).toMatchObject({ rolledBack: true, rulesChanged: true });
    expect(data.error.details.presentAfterUndo[0].remote).toEqual({ kind: 'domains', values: ['stray.example'] });
  });

  it('says plainly when the earlier configuration could not be put back, with the command to do it by hand', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule', 'reject'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('could NOT be undone automatically');
    expect(data.error.message).toContain('restore-model --preserve-terminal-access');
    expect(data.error.message).toContain(path.join(h.dataDir, 'backups', data.error.details.backup));
    expect(data.error.details).toMatchObject({ rolledBack: false, rulesChanged: true });
    expect(auditLog(h)).toMatchObject([{ outcome: 'not-rolled-back' }]);
  });

  it('reports a configuration Little Snitch refused, with nothing changed', async () => {
    const h = await start({ restoreBehaviors: ['reject'] });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('cli-failed');
    expect(data.error.message).toContain('the backup file is not valid');
    expect(h.modelText()).toBe(sampleModelText());
    expect(readdirSync(path.join(h.dataDir, 'pending'))).toEqual([]);
    expect(auditLog(h)).toMatchObject([{ outcome: 'failed', detail: 'cli-failed' }]);
  });

  it('keeps terminal access switched on across the change', async () => {
    const h = await start();
    await h.call('add_rule', NEW_RULE);
    const { data } = await h.call('get_status');
    expect(data.terminalAccess).toBe('enabled');
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
    expect(auditLog(h)[0]?.['summary']).toBe(`change action, notes of the rule for ${SAFARI} to domains: example.com`);
  });

  it('shows before and after on a dry run', async () => {
    const h = await start();
    const { data } = await h.call('update_rule', { ref: ORIGINAL_REFS[3], priority: 'regular', dry_run: true });
    expect(data.preview.before.priority).toBe('high');
    expect(data.preview.after.priority).toBe('regular');
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

  it('puts the rule back when the changed rule vanished', async () => {
    const h = await start({ restoreBehaviors: ['drop-first-rule'] });
    const { data } = await h.call('update_rule', { ref: ORIGINAL_REFS[0], action: 'deny' });
    expect(data.error.details).toMatchObject({ rolledBack: true });
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
    expect(preview.data).toMatchObject({ applied: false, dryRun: true, effect: { rulesRemoved: 0, rulesAdded: 1 } });
    expect(preview.data.effect.examplesAdded[0]).toMatchObject({ process: SLACK });
    expect(refs(h)).toHaveLength(3);

    const restored = await h.call('restore_backup', { name: removed.data.backup });
    expect(restored.data).toMatchObject({ applied: true, restored: removed.data.backup, rulesNow: 4 });
    expect(restored.data.savedBefore).toMatch(/before-restore-backup/);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(auditLog(h).map((entry) => [entry['tool'], entry['outcome']])).toEqual([['remove_rule', 'applied'], ['restore_backup', 'applied']]);
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
    expect(data.error.details).toMatchObject({ rolledBack: false, rulesChanged: false });
    expect(data.error.details.notRemoved.map((rule: { process: string }) => rule.process)).toEqual([SAFARI]);
  });

  it('takes a backup only by a file name this server made', async () => {
    const h = await start();
    expect((await h.call('restore_backup', { name: '../../etc/passwd' })).data.error.kind).toBe('invalid-input');
    expect((await h.call('restore_backup', { name: '20260101T000000Z-manual-abcdef.json' })).data.error.kind).toBe('not-found');
    expect(h.calls()).toEqual([]);
  });

  it('points out rules that are there after a restore and were not in the backup', async () => {
    const h = await start({ restoreBehaviors: ['accept', 'add-stray-rule'] });
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    const { data, isError } = await h.call('restore_backup', { name: removed.data.backup });
    expect(isError).toBe(false);
    expect(data.notes).toEqual(['1 rule(s) are in the configuration that the backup did not contain.']);
    expect(data.notInBackup[0].remote).toEqual({ kind: 'domains', values: ['stray.example'] });
  });

  it('reports a restore after which rules of the backup are missing', async () => {
    const h = await start({ restoreBehaviors: ['accept', 'drop-first-rule'] });
    const removed = await h.call('remove_rule', { ref: ORIGINAL_REFS[1] });
    const { data } = await h.call('restore_backup', { name: removed.data.backup });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('1 of its rules are not in the configuration afterwards');
    expect(data.error.details.savedBefore).toMatch(/before-restore-backup/);
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
