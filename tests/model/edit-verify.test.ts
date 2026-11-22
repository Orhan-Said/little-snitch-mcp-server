import { describe, expect, it } from 'vitest';
import { addRule, buildRule, findRule, removeRule, updateRule, validateNewRule, type NewRuleSpec } from '../../src/model/edit.js';
import { parseModelText, rulesOf, serializeModel, toPlain, type JsonObject } from '../../src/model/json.js';
import { ruleRef } from '../../src/model/rules.js';
import { verifyChange } from '../../src/model/verify.js';
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

describe('verifyChange', () => {
  it('accepts an added rule that came back exactly as sent', () => {
    const before = sampleModel();
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: before });
    const result = verifyChange(before, reexport(addRule(before, rule)), { removedRefs: [], added: [rule] });
    expect(result).toMatchObject({ ok: true, missing: [], notApplied: [], notRemoved: [], unexpected: [], otherChanges: [], shouldRollBack: false });
  });

  it('accepts an added rule Little Snitch respelled, and traffic that happened meanwhile', () => {
    const before = sampleModel();
    const rule = buildRule({ ...SPEC, protocol: 'tcp' }, { uid: 501, now: NOW, model: before });
    const respelled = { ...rule, protocol: '6', direction: 'outgoing', 'remote-domains': ['tracker.example'], approved: true };
    const after = parseModelText(serializeModel(addRule(before, respelled)).replace('"useCount":42', '"useCount":57'));
    expect(verifyChange(before, after, { removedRefs: [], added: [rule] }).ok).toBe(true);
  });

  it('reports a rule Little Snitch silently dropped, with nothing to roll back', () => {
    const before = sampleModel();
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: before });
    const result = verifyChange(before, reexport(before), { removedRefs: [], added: [rule] });
    expect(result.ok).toBe(false);
    expect(result.notApplied.map((entry) => entry.process)).toEqual([CURL]);
    expect(result.shouldRollBack).toBe(false);
  });

  it('asks for a rollback when another rule was lost', () => {
    const before = sampleModel();
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: before });
    const damaged = removeRule(addRule(before, rule), ref(before, 0)).model;
    const result = verifyChange(before, reexport(damaged), { removedRefs: [], added: [rule] });
    expect(result.ok).toBe(false);
    expect(result.missing.map((entry) => entry.process)).toEqual([SAFARI]);
    expect(result.shouldRollBack).toBe(true);
  });

  it('asks for a rollback when the rule came back meaning something else', () => {
    const before = sampleModel();
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: before });
    const result = verifyChange(before, reexport(addRule(before, { ...rule, action: 'allow' })), { removedRefs: [], added: [rule] });
    expect(result.notApplied).toHaveLength(1);
    expect(result.unexpected.map((entry) => entry.action)).toEqual(['allow']);
    expect(result.shouldRollBack).toBe(true);
  });

  it('accepts a removal and reports a removal that did not happen', () => {
    const before = sampleModel();
    const target = ref(before, 0);
    expect(verifyChange(before, reexport(removeRule(before, target).model), { removedRefs: [target], added: [] }).ok).toBe(true);
    const unchanged = verifyChange(before, reexport(before), { removedRefs: [target], added: [] });
    expect(unchanged.ok).toBe(false);
    expect(unchanged.notRemoved.map((entry) => entry.process)).toEqual([SAFARI]);
    expect(unchanged.shouldRollBack).toBe(false);
  });

  it('accepts an update and asks for a rollback when the updated rule vanished', () => {
    const before = sampleModel();
    const target = ref(before, 0);
    const { model: next, after } = updateRule(before, target, { action: 'deny' }, NOW);
    expect(verifyChange(before, reexport(next), { removedRefs: [target], added: [after] }).ok).toBe(true);
    const vanished = verifyChange(before, reexport(removeRule(before, target).model), { removedRefs: [target], added: [after] });
    expect(vanished.ok).toBe(false);
    expect(vanished.shouldRollBack).toBe(true);
  });

  it('notes a rule that appeared on its own without failing the change', () => {
    const before = sampleModel();
    const rule = buildRule(SPEC, { uid: 501, now: NOW, model: before });
    const stray = { action: 'allow', process: SAFARI, 'remote-domains': 'made-in-the-app.example' };
    const result = verifyChange(before, reexport(addRule(addRule(before, rule), stray)), { removedRefs: [], added: [rule] });
    expect(result.ok).toBe(true);
    expect(result.unexpected.map((entry) => entry.remote)).toEqual([{ kind: 'domains', values: ['made-in-the-app.example'] }]);
  });

  it('reports rule groups and profiles that changed alongside', () => {
    const before = sampleModel();
    const after = parseModelText(
      serializeModel(before)
        .replace('"aaaaac":{"kind":"builtinICloudServices","name":null,"isActive":false}', '"aaaaac":{"kind":"builtinICloudServices","name":null,"isActive":true}')
        .replace('"p1":{"name":"Home"},', ''),
    );
    expect(verifyChange(before, after, { removedRefs: [], added: [] }).otherChanges).toEqual([
      'The rule group "iCloud Services" is now on.',
      'The profile "Home" is gone.',
    ]);
  });
});
