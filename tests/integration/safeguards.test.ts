import { readdirSync, readFileSync } from 'node:fs';
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
const OTHER_RULE = { action: 'deny', process: SLACK, remote_hosts: ['second.example'] };
const refs = (h: Harness): string[] => rulesOf(h.model()).map(ruleRef);
/** The commands that need root. The status tool's own two (--version, restrictions) are left out. */
const commands = (h: Harness): string[] => h.calls().map((call) => call[0] ?? '').filter((command) => command !== '--version' && command !== 'restrictions');
const pending = (h: Harness): string[] => readdirSync(path.join(h.dataDir, 'pending'));
const domains = (h: Harness): unknown[] => rulesOf(h.model()).map((rule) => toPlain(rule['remote-domains'] ?? rule['remote-hosts'] ?? null));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) {
    await sleep(25);
  }
}

describe('a change whose command does not end in time', () => {
  it('starts no further change while that command may still be at work, so the next change is never built on a configuration about to be replaced', async () => {
    // The fake's restore outlives the process the server started and killed, and lands 5 seconds after it began.
    const h = await start({ restoreTakesMs: 5000, commandTimeoutMs: 1500, settleMs: 500 });

    const first = await h.call('add_rule', NEW_RULE);
    const timedOutAt = Date.now();
    expect(first.data.error.kind).toBe('verification-failed');
    expect(first.data.error.message).toContain('may still be running as root');
    expect(first.data.error.details).toMatchObject({ rolledBack: false, configurationAsBefore: 'unknown', cause: 'timeout' });
    expect(commands(h)).toEqual(['export-model', 'restore-model']);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
    // The file that command may still be reading is left where it is.
    expect(pending(h)).toHaveLength(1);
    expect((await h.call('get_status')).data).toMatchObject({ waitingAfterTimedOutChange: true });

    // Asked again at once: refused, and nothing is run.
    const second = await h.call('add_rule', OTHER_RULE);
    expect(second.data.error.kind).toBe('busy');
    expect(second.data.error.message).toContain('An earlier change did not end in time');
    // Another server on this Mac is kept out as well: the lock is still held.
    await expect(acquireKernelLock(h.lockFile)).rejects.toMatchObject({ kind: 'busy' });

    // The wait has passed, but the command is still at work: still refused.
    await sleep(Math.max(0, 700 - (Date.now() - timedOutAt)));
    expect(h.restoreAtWork()).toBe(true);
    const third = await h.call('add_rule', OTHER_RULE);
    expect(third.data.error.kind).toBe('busy');
    expect(third.data.error.message).toContain('is still running');
    expect(commands(h)).toEqual(['export-model', 'restore-model']);

    // The late command lands: the first rule is there after all.
    await until(() => !h.restoreAtWork(), 10_000);
    expect(h.restoreAtWork()).toBe(false);
    expect(domains(h)).toContain('tracker.example');

    // Now a change starts from the configuration as it really is, and both rules are kept.
    const fourth = await h.call('add_rule', OTHER_RULE);
    expect(fourth.data.applied).toBe(true);
    expect(domains(h).slice(4)).toEqual(['tracker.example', 'second.example']);
    expect(refs(h).slice(0, 4)).toEqual(ORIGINAL_REFS);
    expect(pending(h)).toEqual([]);
    expect((await h.call('get_status')).data).toMatchObject({ waitingAfterTimedOutChange: false });
    await (await acquireKernelLock(h.lockFile)).release();
  }, 30_000);

  it('gives the lock back by itself once the wait is over and the command is gone', async () => {
    const h = await start({ restoreTakesMs: 2500, commandTimeoutMs: 1500, settleMs: 300 });
    expect((await h.call('add_rule', NEW_RULE)).data.error.details.configurationAsBefore).toBe('unknown');
    await expect(acquireKernelLock(h.lockFile)).rejects.toMatchObject({ kind: 'busy' });
    // No further call is made to this server. The lock comes free on its own.
    let lock;
    const end = Date.now() + 25_000;
    while (lock === undefined && Date.now() < end) {
      lock = await acquireKernelLock(h.lockFile).catch(() => undefined);
      if (lock === undefined) {
        await sleep(200);
      }
    }
    expect(lock?.isHeld()).toBe(true);
    expect(h.restoreAtWork()).toBe(false);
    await lock?.release();
  }, 40_000);
});

describe('what the owner switched off in Little Snitch itself', () => {
  // Little Snitch 6.5 writes the switch as a number, 1 for on.
  const editing = (value: string): string => sampleModelText().replace('"allowRuleAndProfileEditing": 1', `"allowRuleAndProfileEditing": ${value}`);

  it('does not add, change, remove or restore when "Allow Rule Editing" is off for this user', async () => {
    const h = await start({ modelText: editing('0') });
    const refsNow = refs(h);
    const backup = (await h.call('create_backup', {})).data.backup.name as string;
    for (const [tool, args] of [
      ['add_rule', NEW_RULE],
      ['update_rule', { ref: refsNow[0], action: 'deny' }],
      ['remove_rule', { ref: refsNow[0] }],
      ['restore_backup', { name: backup }],
    ] as const) {
      const { data } = await h.call(tool, args);
      expect(data.error.kind, tool).toBe('capability-disabled');
      expect(data.error.message).toContain('"Allow Rule Editing" is switched off');
    }
    expect(commands(h)).toEqual(['export-model', 'export-model', 'export-model', 'export-model', 'export-model']);
    expect(refs(h)).toEqual(refsNow);
  });

  it('takes a false for "off" as well, and refuses a value it does not understand', async () => {
    const plain = await start({ modelText: editing('false') });
    expect((await plain.call('add_rule', NEW_RULE)).data.error.message).toContain('"Allow Rule Editing" is switched off');
    await plain.close();
    const odd = await start({ modelText: editing('{"sometimes": true}') });
    const { data } = await odd.call('add_rule', NEW_RULE);
    expect(data.error.kind).toBe('capability-disabled');
    expect(data.error.message).toContain('has a value in the configuration that this server does not understand');
    expect(commands(odd)).toEqual(['export-model']);
  });

  it('makes the change when the switch is not in the configuration, and says in the result that it could not respect it', async () => {
    const h = await start({ modelText: sampleModelText().replace('"allowRuleAndProfileEditing": 1, ', '') });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.applied).toBe(true);
    expect(data.warnings).toEqual([
      'Little Snitch\'s own switch "Allow Rule Editing" was not found in the configuration for this user, so this server could not respect it. If you switched it off in Little Snitch, undo this change there.',
    ]);
    expect((await h.call('get_status')).data.littleSnitchSwitches).toEqual({ allowRuleEditing: 'not-found', allowProfileSwitching: 'on' });
  });

  it('shows in the status what it read, once the configuration has been read', async () => {
    const h = await start();
    expect((await h.call('get_status')).data.littleSnitchSwitches).toContain('not read yet');
    await h.call('list_rules');
    expect((await h.call('get_status')).data.littleSnitchSwitches).toEqual({ allowRuleEditing: 'on', allowProfileSwitching: 'on' });
    // The status tool itself read nothing that needs approval.
    expect(commands(h).filter((command) => command === 'export-model')).toHaveLength(1);
  });

  it('is not held back by the switch of another macOS user', async () => {
    const h = await start({
      modelText: sampleModelText().replace('"users": [', '"users": [\n    { "uid": 502, "shortName": "other", "fullName": "Other", "defaults": { "allowRuleAndProfileEditing": false } },'),
    });
    const { data } = await h.call('add_rule', NEW_RULE);
    expect(data.applied).toBe(true);
    expect(data.warnings).toBeUndefined();
  });
});

describe('an existing rule that an approval prompt could not show exactly', () => {
  const withRule = (rule: string): string => sampleModelText().replace('"rules": [', `"rules": [\n    ${rule},`);
  const refused = async (rule: string, reason: string): Promise<void> => {
    const h = await start({ modelText: withRule(rule) });
    const target = refs(h)[0];
    const before = h.modelText();
    for (const [tool, args] of [
      ['update_rule', { ref: target, notes: 'looked at' }],
      ['remove_rule', { ref: target }],
      ['remove_rule', { ref: target, dry_run: true }],
    ] as const) {
      const { data, isError } = await h.call(tool, args);
      expect(isError, tool).toBe(true);
      expect(data.error.kind).toBe('invalid-input');
      expect(data.error.message).toContain(reason);
      expect(data.error.message).toContain('Change or remove it in Little Snitch itself.');
    }
    expect(commands(h)).toEqual(['export-model', 'export-model', 'export-model']);
    expect(h.modelText()).toBe(before);
    await h.close();
    harness = undefined;
  };

  it('is not changed or removed when its remote list holds an entry that is not text', async () => {
    await refused(`{ "action": "allow", "origin": "frontend", "uid": 501, "process": "${CURL}", "remote-hosts": ["shown.example", { "host": "hidden.example" }] }`, 'a "remote-hosts" value that is not text or a list of texts');
  });

  it('is not changed or removed when it has two remote fields', async () => {
    await refused(`{ "action": "allow", "origin": "frontend", "uid": 501, "process": "${CURL}", "remote-domains": "shown.example", "remote-addresses": ["203.0.113.9"] }`, 'more than one remote field (remote-domains, remote-addresses)');
  });

  it('is not changed or removed when a remote keyword would be cut', async () => {
    await refused(`{ "action": "allow", "origin": "frontend", "uid": 501, "process": "${CURL}", "remote": "local-net-and-a-great-deal-more-than-would-fit-here" }`, 'a "remote" entry that is empty, too long');
  });

  it('is not changed or removed when its direction is one this server would print wrongly', async () => {
    await refused(`{ "action": "allow", "origin": "frontend", "uid": 501, "process": "${CURL}", "remote": "any", "direction": "sideways" }`, 'a direction this server does not know');
  });
});

describe('update_rule and the rules it must not produce', () => {
  it('does not turn a rule into a second copy of another rule', async () => {
    const twin = `{ "action": "deny", "origin": "frontend", "uid": 501, "process": "${SAFARI}", "remote-domains": "example.com" }`;
    const h = await start({ modelText: sampleModelText().replace('"rules": [', `"rules": [\n    ${twin},`) });
    const [denyRef, allowRef] = refs(h);
    const { data } = await h.call('update_rule', { ref: denyRef, action: 'allow' });
    expect(data.error.kind).toBe('invalid-input');
    expect(data.error.message).toBe(`After this change the rule would mean the same as another rule (ref ${allowRef}). Remove one of the two instead.`);
    expect(commands(h)).toEqual(['export-model']);
    // A change that leaves the meaning alone is still possible.
    expect((await h.call('update_rule', { ref: denyRef, notes: 'kept for now' })).data.applied).toBe(true);
  });

  it('does not treat another user\'s rule as that copy', async () => {
    const other = `{ "action": "deny", "origin": "frontend", "uid": 502, "process": "${SAFARI}", "remote-domains": "example.com" }`;
    const h = await start({ modelText: sampleModelText().replace('"rules": [', `"rules": [\n    ${other},`) });
    const { data } = await h.call('update_rule', { ref: refs(h)[0], action: 'allow' });
    expect(data.applied).toBe(true);
  });

  it('refuses to add a rule for any process and every address, and runs nothing for it', async () => {
    const h = await start();
    for (const dryRun of [true, false]) {
      const { data } = await h.call('add_rule', { action: 'allow', process: 'any', remote_addresses: ['0.0.0.0/0', '::/0'], dry_run: dryRun });
      expect(data.error.kind).toBe('invalid-input');
      expect(data.error.message).toContain('covers all or nearly all IPv4 addresses counts as any remote');
    }
    expect(commands(h)).toEqual([]);
    expect(refs(h)).toEqual(ORIGINAL_REFS);
  });

  it('does not turn a deny rule for any process and every address into allow', async () => {
    const catchAll = '{ "action": "deny", "origin": "frontend", "uid": 501, "process": "any", "remote-addresses": ["0.0.0.0/0", "::/0"] }';
    const h = await start({ modelText: sampleModelText().replace('"rules": [', `"rules": [\n    ${catchAll},`) });
    const target = refs(h)[0];
    const { data } = await h.call('update_rule', { ref: target, action: 'allow' });
    expect(data.error.kind).toBe('invalid-input');
    expect(data.error.message).toContain('This server does not change the action or the priority of such a rule');
    expect(refs(h)[0]).toBe(target);
  });

  it('does not turn a deny rule for any process and any remote into allow, the rule add_rule refuses to create', async () => {
    const catchAll = '{ "action": "deny", "origin": "frontend", "uid": 501, "process": "any", "remote": "any" }';
    const h = await start({ modelText: sampleModelText().replace('"rules": [', `"rules": [\n    ${catchAll},`) });
    const target = refs(h)[0];
    for (const patch of [{ action: 'allow' }, { priority: 'high' }]) {
      const { data } = await h.call('update_rule', { ref: target, ...patch });
      expect(data.error.kind).toBe('invalid-input');
      expect(data.error.message).toContain('This server does not change the action or the priority of such a rule');
    }
    expect(commands(h)).toEqual(['export-model', 'export-model']);
    expect(refs(h)[0]).toBe(target);
  });
});

describe('the change log', () => {
  it('says "applied" for a change that was read back', async () => {
    const h = await start();
    await h.call('add_rule', NEW_RULE);
    const lines = readFileSync(path.join(h.dataDir, 'changes.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
    expect(lines).toMatchObject([{ tool: 'add_rule', outcome: 'applied' }]);
  });
});
