import { describe, expect, it } from 'vitest';
import { addRule, buildRule, findRule, removeRule, updateRule, validateNewRule, type NewRuleSpec } from '../../src/model/edit.js';
import { parseModelText, rulesOf, serializeModel, toPlain, type JsonObject } from '../../src/model/json.js';
import { ruleRef } from '../../src/model/rules.js';
import { compareModels, describeComparison } from '../../src/model/verify.js';
import { CURL, SAFARI, sampleModel } from '../fixtures/model.js';

const NOW = new Date('2026-11-22T16:00:00Z');
const SPEC: NewRuleSpec = { action: 'deny', process: CURL, remoteDomains: ['Tracker.Example'] };

function ref(model: JsonObject, index: number): string {
  const rule = rulesOf(model)[index];
  if (rule === undefined) {
    throw new Error(`no rule ${index}`);
  }
  return ruleRef(rule);
}

/** What Little Snitch would print after reading a configuration: a fresh parse of the same text. */
function reexport(model: JsonObject): JsonObject {
  return parseModelText(serializeModel(model));
}

describe('validateNewRule', () => {
  const reject = (spec: NewRuleSpec, message: RegExp): void => {
    expect(() => validateNewRule(spec)).toThrow(message);
  };

  it('accepts ordinary rules', () => {
    expect(() => validateNewRule(SPEC)).not.toThrow();
    expect(() => validateNewRule({ action: 'allow', process: 'any', remoteAddresses: ['10.0.0.0/8', '192.168.1.1-192.168.1.9', 'fe80::1'] })).not.toThrow();
    expect(() => validateNewRule({ action: 'allow', process: SAFARI, remote: 'local-net', ports: '8000-8100', protocol: 'tcp' })).not.toThrow();
  });

  it('refuses a rule for any process and any remote, allow or deny', () => {
    reject({ action: 'allow', process: 'any', remote: 'any' }, /switch the firewall off/);
    reject({ action: 'deny', process: 'any', remote: 'any' }, /cut the Mac off/);
  });

  it('refuses a process that is not an executable path', () => {
    reject({ ...SPEC, process: 'Safari' }, /absolute path/);
    reject({ ...SPEC, process: '/Applications/Safari.app' }, /executable inside the app/);
    reject({ ...SPEC, via: 'ping' }, /"via" process must be an absolute path/);
  });

  it('refuses no remote, two remotes, and malformed remotes', () => {
    reject({ action: 'deny', process: CURL }, /exactly one of/);
    reject({ ...SPEC, remote: 'any' }, /exactly one of/);
    reject({ action: 'deny', process: CURL, remoteDomains: ['https://example.com/path'] }, /not a host or domain name/);
    reject({ action: 'deny', process: CURL, remoteDomains: ['*.example.com'] }, /not a host or domain name/);
    reject({ action: 'deny', process: CURL, remoteHosts: [] }, /between 1 and 200/);
    reject({ action: 'deny', process: CURL, remoteAddresses: ['999.1.1.1'] }, /not an IP address/);
    reject({ action: 'deny', process: CURL, remoteAddresses: ['10.0.0.0/64'] }, /not an IP address/);
  });

  it('refuses bad ports and notes', () => {
    reject({ ...SPEC, ports: '70000' }, /Ports must be/);
    reject({ ...SPEC, ports: '443-80' }, /Ports must be/);
    reject({ ...SPEC, ports: '80,443' }, /Ports must be/);
    reject({ ...SPEC, notes: 'x'.repeat(501) }, /at most 500/);
  });
});

describe('buildRule', () => {
  it('builds the short form Little Snitch itself writes, with dates as text when the other rules use text', () => {
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: sampleModel() });
    expect(toPlain(rule)).toEqual({
      action: 'deny',
      creationDate: '2026-11-22T16:00:00Z',
      modificationDate: '2026-11-22T16:00:00Z',
      origin: 'frontend',
      uid: 501,
      process: CURL,
      'remote-domains': 'tracker.example',
    });
  });

  it('writes dates as seconds from 2001 when the other rules do', () => {
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: sampleModel({ dates: 'cocoa' }) });
    expect(toPlain(rule['creationDate'])).toBe(817056000);
  });

  it('leaves dates out when no rule shows which form to use', () => {
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: parseModelText('{"rules":[]}') });
    expect(Object.keys(rule)).toEqual(['action', 'origin', 'uid', 'process', 'remote-domains']);
  });

  it('writes only the options that differ from the defaults', () => {
    const rule = buildRule(
      { action: 'allow', process: SAFARI, via: CURL, remoteHosts: ['a.example', 'b.example'], direction: 'incoming', ports: '443', protocol: 'tcp', priority: 'high', notes: 'for work' },
      { uid: 502, now: NOW, model: parseModelText('{"rules":[]}') },
    );
    expect(toPlain(rule)).toEqual({
      action: 'allow', origin: 'frontend', uid: 502, process: SAFARI, via: CURL, 'remote-hosts': ['a.example', 'b.example'],
      direction: 'incoming', ports: '443', protocol: 'tcp', priority: 'high', notes: 'for work',
    });
    const plain = buildRule({ action: 'allow', process: SAFARI, remote: 'local-net', direction: 'outgoing', ports: 'any', priority: 'regular', notes: '' }, { uid: 502, now: NOW, model: parseModelText('{"rules":[]}') });
    expect(Object.keys(plain)).toEqual(['action', 'origin', 'uid', 'process', 'remote']);
  });

  it('refuses an invalid request', () => {
    expect(() => buildRule({ action: 'allow', process: 'any', remote: 'any' }, { uid: 501, now: NOW, model: sampleModel() })).toThrow(/firewall off/);
  });
});

describe('addRule, removeRule and updateRule', () => {
  it('adds a rule at the end and leaves the original configuration untouched', () => {
    const model = sampleModel();
    const next = addRule(model, buildRule(SPEC, { uid: 501, now: NOW, model }));
    expect(rulesOf(next)).toHaveLength(5);
    expect(rulesOf(model)).toHaveLength(4);
    expect(Object.keys(next)).toEqual(Object.keys(model));
  });

  it('removes exactly the rule with the given reference', () => {
    const model = sampleModel();
    const { model: next, removed } = removeRule(model, ref(model, 0));
    expect(removed['process']).toBe(SAFARI);
    expect(rulesOf(next).map(ruleRef)).toEqual([ref(model, 1), ref(model, 2), ref(model, 3)]);
  });

  it('refuses to remove or change a protected factory rule', () => {
    const model = sampleModel();
    expect(() => removeRule(model, ref(model, 2))).toThrow(/protected or factory rule/);
    expect(() => updateRule(model, ref(model, 2), { action: 'deny' }, NOW)).toThrow(/protected or factory rule/);
  });

  it('reports an unknown reference and a reference shared by identical rules', () => {
    expect(() => findRule(sampleModel(), 'r000000000000')).toThrow(/No rule has the reference r000000000000/);
    const twins = parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"},{"action":"allow","process":"any","remote":"bonjour"}]}');
    expect(() => findRule(twins, ref(twins, 0))).toThrow(/2 identical rules/);
  });

  it('changes only the requested fields and the modification date', () => {
    const model = sampleModel();
    const { after, before, model: next } = updateRule(model, ref(model, 0), { action: 'deny', notes: 'blocked for now' }, NOW);
    expect(before['action']).toBe('allow');
    expect(toPlain(after)).toEqual({ ...(toPlain(before) as object), action: 'deny', notes: 'blocked for now', modificationDate: '2026-11-22T16:00:00Z' });
    expect(rulesOf(next)[1]).toBe(rulesOf(model)[1]);
  });

  it('removes a note or a high priority by leaving the field out', () => {
    const model = sampleModel();
    const cleared = updateRule(model, ref(model, 1), { notes: '' }, NOW).after;
    expect('notes' in cleared).toBe(false);
    const regular = updateRule(model, ref(model, 3), { priority: 'regular' }, NOW).after;
    expect('priority' in regular).toBe(false);
    expect(toPlain(regular['futureFlag'])).toBe('18446744073709551615');
  });

  it('refuses a change that changes nothing', () => {
    const model = sampleModel();
    expect(() => updateRule(model, ref(model, 0), { action: 'allow' }, NOW)).toThrow(/Nothing to change/);
  });
});

describe('compareModels', () => {
  const add = (before: JsonObject, spec: NewRuleSpec = SPEC) => {
    const rule = buildRule(spec, { uid: 501, now: NOW, model: before });
    return { rule, next: addRule(before, rule) };
  };

  it('accepts a written rule that came back exactly as sent', () => {
    const before = sampleModel();
    const { rule, next } = add(before);
    expect(compareModels(next, reexport(next), { written: [rule] })).toEqual({
      ok: true, missing: [], unexpected: [], notApplied: [], notRemoved: [], changedSections: [], otherChanges: [],
    });
  });

  it('accepts the known respellings of a written rule, its own dates, and traffic that happened meanwhile', () => {
    const before = sampleModel();
    const { rule, next } = add(before, { ...SPEC, protocol: 'tcp' });
    const respelled = { ...rule, protocol: '6', direction: 'outgoing', priority: 'regular', ports: 'any', 'remote-domains': ['tracker.example'], modificationDate: '2026-11-22T16:00:07Z' };
    const after = parseModelText(serializeModel(addRule(before, respelled)).replace('"useCount":42', '"useCount":57'));
    expect(compareModels(next, after, { written: [rule] }).ok).toBe(true);
  });

  it('does not accept a written rule that came back for another user, group or note, disabled, or with a field nobody sent', () => {
    const before = sampleModel();
    const { rule, next } = add(before);
    const variants: JsonObject[] = [
      { ...rule, uid: parseModelText('{"n":0}')['n'] ?? null },
      { ...rule, group: 'aaaaac' },
      { ...rule, notes: 'not what was asked' },
      { ...rule, disabled: true },
      { ...rule, profile: 'p1' },
      { ...rule, action: 'allow' },
      Object.fromEntries(Object.entries(rule).filter(([key]) => key !== 'uid')),
    ];
    for (const variant of variants) {
      const result = compareModels(next, reexport(addRule(before, variant)), { written: [rule] });
      expect(result.ok).toBe(false);
      expect(result.notApplied).toHaveLength(1);
      expect(result.unexpected).toHaveLength(1);
    }
  });

  it('does not accept a rule nobody asked for, whatever else is right', () => {
    const before = sampleModel();
    const { rule, next } = add(before);
    const stray = { action: 'allow', process: 'any', remote: 'any' };
    const result = compareModels(next, reexport(addRule(next, stray)), { written: [rule] });
    expect(result.ok).toBe(false);
    expect(result.unexpected.map((entry) => entry.remote)).toEqual([{ kind: 'any' }]);
    expect(describeComparison(result)).toBe('1 rule(s) nobody asked for');
  });

  it('does not accept a change to a preference, a rule group or a profile', () => {
    const before = sampleModel();
    const { rule, next } = add(before);
    const text = serializeModel(next);
    const preference = compareModels(next, parseModelText(text.replace('"allowCommandLineAccess":true', '"allowCommandLineAccess":false')), { written: [rule] });
    expect(preference).toMatchObject({ ok: false, changedSections: ['globalDefaults'], missing: [], unexpected: [] });
    const group = compareModels(next, parseModelText(text.replace('"kind":"builtinICloudServices","name":null,"isActive":false', '"kind":"builtinICloudServices","name":null,"isActive":true')), { written: [rule] });
    expect(group).toMatchObject({ ok: false, changedSections: ['groups'], otherChanges: ['The rule group "iCloud Services" is on and should be off.'] });
    const profile = compareModels(next, parseModelText(text.replace('"p1":{"name":"Home"},', '')), { written: [rule] });
    expect(profile).toMatchObject({ ok: false, changedSections: ['profiles'], otherChanges: ['The profile "Home" is gone.'] });
    const user = compareModels(next, parseModelText(text.replace('"activeProfile":"p2"', '"activeProfile":"p1"')), { written: [rule] });
    expect(user.changedSections).toEqual(['users']);
    const added = compareModels(next, parseModelText(text.replace('"networkTriggers":[]', '"networkTriggers":[],"somethingNew":{"on":true}')), { written: [rule] });
    expect(added.changedSections).toEqual(['somethingNew']);
  });

  it('ignores only the parts Little Snitch keeps for itself', () => {
    const before = sampleModel();
    const after = parseModelText(
      serializeModel(before)
        .replace('"bundleVersion":6500', '"bundleVersion":6501,"blocklistStatistics":{"hits":9},"lastSeenExecutableByCodeIdentifier":{"a":"b"}')
        .replace('"factoryRuleSetVersion":12', '"factoryRuleSetVersion":13'),
    );
    expect(compareModels(before, after).ok).toBe(true);
  });

  it('reports a rule that was lost, and one that was not removed', () => {
    const before = sampleModel();
    const target = ref(before, 0);
    const { model: next } = removeRule(before, target);
    expect(compareModels(next, reexport(next), { removedRefs: [target] }).ok).toBe(true);
    const unchanged = compareModels(next, reexport(before), { removedRefs: [target] });
    expect(unchanged.ok).toBe(false);
    expect(unchanged.notRemoved.map((entry) => entry.process)).toEqual([SAFARI]);
    expect(unchanged.unexpected).toEqual([]);
    const lost = compareModels(before, reexport(next));
    expect(lost.missing.map((entry) => entry.process)).toEqual([SAFARI]);
    expect(describeComparison(lost)).toBe('1 rule(s) missing');
  });

  it('accepts an update and reports an updated rule that vanished or kept its old form', () => {
    const before = sampleModel();
    const target = ref(before, 0);
    const { model: next, after: updated } = updateRule(before, target, { action: 'deny' }, NOW);
    expect(compareModels(next, reexport(next), { written: [updated], removedRefs: [target] }).ok).toBe(true);
    const vanished = compareModels(next, reexport(removeRule(before, target).model), { written: [updated], removedRefs: [target] });
    expect(vanished).toMatchObject({ ok: false, unexpected: [], notRemoved: [] });
    expect(vanished.notApplied).toHaveLength(1);
    const kept = compareModels(next, reexport(before), { written: [updated], removedRefs: [target] });
    expect(kept.notApplied).toHaveLength(1);
    expect(kept.notRemoved).toHaveLength(1);
  });

  it('notices a rule-list entry that is not a rule object when it disappears or appears', () => {
    const withOpaque = parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"},"opaque-entry",42]}');
    const without = parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"}]}');
    expect(compareModels(withOpaque, reexport(withOpaque)).ok).toBe(true);
    expect(compareModels(withOpaque, without)).toMatchObject({ ok: false, changedSections: ['rules (entries that are not rule objects)'] });
    expect(compareModels(without, withOpaque).ok).toBe(false);
    expect(compareModels(withOpaque, parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"},"opaque-entry",43]}')).ok).toBe(false);
  });

  it('counts identical rules, so a lost twin is noticed', () => {
    const twins = parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"},{"action":"allow","process":"any","remote":"bonjour"}]}');
    const one = parseModelText('{"rules":[{"action":"allow","process":"any","remote":"bonjour"}]}');
    expect(compareModels(twins, one).missing).toHaveLength(1);
    expect(compareModels(one, twins).unexpected).toHaveLength(1);
    expect(compareModels(twins, reexport(twins)).ok).toBe(true);
  });
});
