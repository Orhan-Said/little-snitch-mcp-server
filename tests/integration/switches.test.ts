import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeGroups } from '../../src/model/groups.js';
import { rulesOf } from '../../src/model/json.js';
import { activeProfile } from '../../src/model/profiles.js';
import { ruleRef } from '../../src/model/rules.js';
import { sampleModel, sampleModelText } from '../fixtures/model.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

let harness: Harness | undefined;
const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness({ allow: ['switches'], ...options });
  return harness;
};
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const ORIGINAL_REFS = rulesOf(sampleModel()).map(ruleRef);
const active = (h: Harness): string | null | undefined => activeProfile(h.model(), 501).name;
const groupState = (h: Harness, id: string): boolean | null | undefined => summarizeGroups(h.model()).find((group) => group.id === id)?.active;
const commands = (h: Harness): string[] => h.calls().map((call) => call[0] ?? '');
const refs = (h: Harness): string[] => rulesOf(h.model()).map(ruleRef);
const auditLog = (h: Harness): Array<Record<string, string>> =>
  readFileSync(path.join(h.dataDir, 'changes.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, string>);

describe('set_active_profile', () => {
  it('activates a profile by its exact name, from a fresh read, with a backup, and confirms it by reading back', async () => {
    const h = await start();
    const { data, isError } = await h.call('set_active_profile', { profile: 'Home' });
    expect(isError).toBe(false);
    expect(data).toEqual({ applied: true, activeProfile: 'Home', confirmedByReadBack: true, partsThatChanged: ['users'], approvedThrough: 'direct' });
    expect(active(h)).toBe('Home');
    expect(h.calls()).toEqual([['export-model'], ['profile', '--activate', 'Home'], ['export-model']]);
    expect(auditLog(h)).toMatchObject([{ tool: 'set_active_profile', outcome: 'applied', summary: 'activate profile "Home"' }]);
    const backups = (await h.call('list_backups')).data.backups;
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(/before-set-active-profile/);
    expect(readFileSync(path.join(h.dataDir, 'backups', backups[0].name), 'utf8')).toBe(sampleModelText());
  });

  it('deactivates all profiles when given null', async () => {
    const h = await start();
    const { data } = await h.call('set_active_profile', { profile: null });
    expect(data).toMatchObject({ applied: true, activeProfile: null, confirmedByReadBack: true });
    expect(active(h)).toBeNull();
    expect(h.calls()).toEqual([['export-model'], ['profile', '--deactivate-all'], ['export-model']]);
  });

  it('does not run anything for a name that is not a profile', async () => {
    const h = await start();
    const { data } = await h.call('set_active_profile', { profile: 'home' });
    expect(data.error.kind).toBe('not-found');
    expect(data.error.details.available).toEqual(['Home', 'Work']);
    expect(h.calls()).toEqual([['export-model']]);
    expect(h.modelText()).toBe(sampleModelText());
  });

  it('never passes a name that looks like an option to the tool', async () => {
    const h = await start({ modelText: sampleModelText().replace('"name": "Home"', '"name": "--deactivate-all"') });
    const { data } = await h.call('set_active_profile', { profile: '--deactivate-all' });
    expect(data.error.kind).toBe('invalid-input');
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('reads the configuration afresh every time, never from an older copy', async () => {
    const h = await start();
    await h.call('list_profiles');
    await h.call('set_active_profile', { profile: 'Home' });
    expect(commands(h)).toEqual(['export-model', 'export-model', 'profile', 'export-model']);
  });

  it('reports a switch that Little Snitch accepted but that changed nothing', async () => {
    const h = await start({ switchesDoNothing: true });
    const { data } = await h.call('set_active_profile', { profile: 'Home' });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('the configuration is the same as before');
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true });
    expect(commands(h)).toEqual(['export-model', 'profile', 'export-model']);
  });

  it('says "accepted", not "applied", when the configuration does not tell which profile is active', async () => {
    // The fake keeps its configuration as it is here, the way a Little Snitch that stores the active profile elsewhere would look.
    const h = await start({ modelText: sampleModelText().replace('"activeProfile": "p2"', '"somethingElse": 1'), switchesDoNothing: true });
    const { data, isError } = await h.call('set_active_profile', { profile: null });
    expect(isError).toBe(false);
    expect(data.applied).toBeUndefined();
    expect(data).toMatchObject({ accepted: true, activeProfile: null, confirmedByReadBack: false, partsThatChanged: [] });
    expect(data.note).toContain('the switch itself is not confirmed');
  });

  it('puts the earlier configuration back when the switch also lost a rule', async () => {
    const h = await start({ switchSideEffects: ['drop-first-rule'] });
    const { data } = await h.call('set_active_profile', { profile: 'Home' });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('is not what the switch should produce (1 rule(s) missing; these parts differ: users)');
    expect(data.error.message).toContain('The earlier configuration was put back and checked');
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(commands(h)).toEqual(['export-model', 'profile', 'export-model', 'restore-model', 'export-model']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    expect(active(h)).toBe('Work');
    expect(auditLog(h)).toMatchObject([{ outcome: 'rolled-back' }]);
  });

  it('reads again and undoes the switch when the read-back failed', async () => {
    const h = await start({ failExportsAfterSwitch: 1 });
    const { data } = await h.call('set_active_profile', { profile: 'Home' });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('could not be read back');
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(commands(h)).toEqual(['export-model', 'profile', 'export-model', 'export-model', 'restore-model', 'export-model']);
    expect(active(h)).toBe('Work');
  });
});

describe('set_rule_group_enabled', () => {
  it('switches a built-in group on by the name Little Snitch shows, and checks the whole configuration', async () => {
    const h = await start();
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data).toEqual({ applied: true, group: { id: 'aaaaac', name: 'iCloud Services' }, enabled: true, confirmedByReadBack: true, approvedThrough: 'direct' });
    expect(groupState(h, 'aaaaac')).toBe(true);
    expect(h.calls()).toEqual([['export-model'], ['rulegroup', '--enable', 'iCloud Services'], ['export-model']]);
  });

  it('switches a group off by its id', async () => {
    const h = await start();
    await h.call('set_rule_group_enabled', { group: 'aaaaad', enabled: false });
    expect(groupState(h, 'aaaaad')).toBe(false);
    expect(h.calls()[1]).toEqual(['rulegroup', '--disable', 'Work rules']);
  });

  it('runs nothing when the group is already in the wanted state', async () => {
    const h = await start();
    const { data, isError } = await h.call('set_rule_group_enabled', { group: 'macOS Services', enabled: true });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ applied: false, alreadyInState: true, group: { id: 'aaaaab', name: 'macOS Services' } });
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('does not guess at a misspelled group or one in another letter case', async () => {
    const h = await start();
    expect((await h.call('set_rule_group_enabled', { group: 'iCloud Service', enabled: true })).data.error.kind).toBe('not-found');
    expect((await h.call('set_rule_group_enabled', { group: 'icloud services', enabled: true })).data.error.kind).toBe('not-found');
    expect(commands(h)).toEqual(['export-model', 'export-model']);
  });

  it('explains that a built-in group without a known name cannot be switched from here', async () => {
    const h = await start();
    const { data } = await h.call('set_rule_group_enabled', { group: 'aaaaae', enabled: false });
    expect(data.error.kind).toBe('not-found');
    expect(data.error.message).toContain('builtinSomethingNew');
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('refuses a name that two groups share, since Little Snitch takes a name only', async () => {
    const h = await start({ modelText: sampleModelText().replace('"kind": "builtinSomethingNew", "name": null', '"kind": "local", "name": "Work rules"') });
    const { data } = await h.call('set_rule_group_enabled', { group: 'aaaaad', enabled: false });
    expect(data.error.kind).toBe('ambiguous');
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('reports a switch that changed nothing', async () => {
    const h = await start({ switchesDoNothing: true });
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: true });
    expect(groupState(h, 'aaaaac')).toBe(false);
  });

  it('puts the earlier configuration back when another group was switched as well', async () => {
    const h = await start({ switchSideEffects: ['switch-other-group'] });
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.details.otherChanges).toEqual(['The rule group "Work rules" is off and should be on.']);
    expect(data.error.details).toMatchObject({ rolledBack: true, configurationAsBefore: true });
    expect(groupState(h, 'aaaaac')).toBe(false);
    expect(groupState(h, 'aaaaad')).toBe(true);
  });

  it('puts the earlier configuration back when a preference changed as well', async () => {
    const h = await start({ switchSideEffects: ['flip-preference'] });
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data.error.details.changedSections).toEqual(['globalDefaults']);
    expect(data.error.details).toMatchObject({ rolledBack: true });
    expect(h.modelText()).toContain('"allowCommandLineAccess":true');
    expect(groupState(h, 'aaaaac')).toBe(false);
  });
});
