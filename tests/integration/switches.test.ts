import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeGroups } from '../../src/model/groups.js';
import { activeProfile } from '../../src/model/profiles.js';
import { sampleModelText } from '../fixtures/model.js';
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

const active = (h: Harness): string | null | undefined => activeProfile(h.model(), 501).name;
const groupState = (h: Harness, id: string): boolean | null | undefined => summarizeGroups(h.model()).find((group) => group.id === id)?.active;

describe('set_active_profile', () => {
  it('activates a profile by its exact name and confirms it by reading back', async () => {
    const h = await start();
    const { data, isError } = await h.call('set_active_profile', { profile: 'Home' });
    expect(isError).toBe(false);
    expect(data).toEqual({ applied: true, activeProfile: 'Home', confirmedByReadBack: true, approvedThrough: 'direct' });
    expect(active(h)).toBe('Home');
    expect(h.calls()).toEqual([['export-model'], ['profile', '--activate', 'Home'], ['export-model']]);
    const log = readFileSync(path.join(h.dataDir, 'changes.log'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ tool: 'set_active_profile', outcome: 'applied', summary: 'activate profile "Home"' });
  });

  it('deactivates all profiles when given null', async () => {
    const h = await start();
    const { data } = await h.call('set_active_profile', { profile: null });
    expect(data).toMatchObject({ applied: true, activeProfile: null, confirmedByReadBack: true });
    expect(active(h)).toBeNull();
    expect(h.calls()).toEqual([['profile', '--deactivate-all'], ['export-model']]);
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

  it('reports a switch that Little Snitch accepted but that did not take effect', async () => {
    const h = await start({ switchesDoNothing: true });
    const { data } = await h.call('set_active_profile', { profile: 'Home' });
    expect(data.error.kind).toBe('verification-failed');
    expect(data.error.message).toContain('reads as "Work"');
  });

  it('says so when it cannot double-check the result', async () => {
    // The fake keeps its configuration as it is here, the way a Little Snitch that stores the active profile elsewhere would look.
    const h = await start({ modelText: sampleModelText().replace('"activeProfile": "p2"', '"somethingElse": 1'), switchesDoNothing: true });
    const { data } = await h.call('set_active_profile', { profile: null });
    expect(data.applied).toBe(true);
    expect(data.confirmedByReadBack).toBe(false);
    expect(data.note).toContain('was not double-checked');
  });

  it('reuses a configuration it has just read to look the name up', async () => {
    const h = await start();
    await h.call('list_profiles');
    await h.call('set_active_profile', { profile: 'Home' });
    expect(h.calls().map((call) => call[0])).toEqual(['export-model', 'profile', 'export-model']);
  });
});

describe('set_rule_group_enabled', () => {
  it('switches a built-in group on by the name Little Snitch shows', async () => {
    const h = await start();
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data).toEqual({ applied: true, group: { id: 'aaaaac', name: 'iCloud Services' }, enabled: true, confirmedByReadBack: true, approvedThrough: 'direct' });
    expect(groupState(h, 'aaaaac')).toBe(true);
    expect(h.calls()[1]).toEqual(['rulegroup', '--enable', 'iCloud Services']);
  });

  it('switches a group off by its id', async () => {
    const h = await start();
    await h.call('set_rule_group_enabled', { group: 'aaaaad', enabled: false });
    expect(groupState(h, 'aaaaad')).toBe(false);
    expect(h.calls()[1]).toEqual(['rulegroup', '--disable', 'Work rules']);
  });

  it('does not guess at a misspelled group', async () => {
    const h = await start();
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Service', enabled: false });
    expect(data.error.kind).toBe('not-found');
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('explains that a built-in group without a known name cannot be switched from here', async () => {
    const h = await start();
    const { data } = await h.call('set_rule_group_enabled', { group: 'aaaaae', enabled: false });
    expect(data.error.kind).toBe('not-found');
    expect(data.error.message).toContain('builtinSomethingNew');
    expect(h.calls()).toEqual([['export-model']]);
  });

  it('reports a switch that did not take effect', async () => {
    const h = await start({ switchesDoNothing: true });
    const { data } = await h.call('set_rule_group_enabled', { group: 'iCloud Services', enabled: true });
    expect(data.error.kind).toBe('verification-failed');
    expect(groupState(h, 'aaaaac')).toBe(false);
  });
});
