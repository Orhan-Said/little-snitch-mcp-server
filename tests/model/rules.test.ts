import { describe, expect, it } from 'vitest';
import { groupDisplayNames, resolveGroup, summarizeGroups } from '../../src/model/groups.js';
import { numberValue, parseModelText, rulesOf, type JsonObject } from '../../src/model/json.js';
import { activeProfile, resolveProfile, summarizeProfiles } from '../../src/model/profiles.js';
import { filterRules, remoteOf, ruleRef, semanticKey, summarizeRule, tolerantKey } from '../../src/model/rules.js';
import { CURL, SAFARI, sampleModel, SLACK } from '../fixtures/model.js';

const NOW = new Date('2026-11-22T16:00:00Z');

function rule(index: number, model: JsonObject = sampleModel()): JsonObject {
  const found = rulesOf(model)[index];
  if (found === undefined) {
    throw new Error(`no rule ${index}`);
  }
  return found;
}

function summaries(model: JsonObject = sampleModel()) {
  const names = groupDisplayNames(model);
  return rulesOf(model).map((entry) => summarizeRule(entry, names));
}

describe('ruleRef', () => {
  it('is an "r" followed by 12 hex digits', () => {
    expect(ruleRef(rule(0))).toMatch(/^r[0-9a-f]{12}$/);
  });

  it('stays the same when Little Snitch only updates the last use and the use count', () => {
    const used = { ...rule(0), lastUsed: numberValue(817000000), useCount: numberValue(43) };
    expect(ruleRef(used)).toBe(ruleRef(rule(0)));
  });

  it('changes when the rule itself changes, and differs between rules', () => {
    expect(ruleRef({ ...rule(0), action: 'deny' })).not.toBe(ruleRef(rule(0)));
    expect(new Set(rulesOf(sampleModel()).map(ruleRef)).size).toBe(4);
  });

  it('does not depend on how dates are written elsewhere in the file or on key order', () => {
    const reordered = parseModelText(
      `{"rules":[{"remote-domains":"example.com","process":"${SAFARI}","uid":501,"origin":"frontend","modificationDate":"2026-01-10T09:00:00Z","creationDate":"2026-01-10T09:00:00Z","action":"allow"}]}`,
    );
    expect(ruleRef(rule(0, reordered))).toBe(ruleRef(rule(0)));
  });
});

describe('summarizeRule', () => {
  it('describes a simple rule a person made', () => {
    expect(summaries()[0]).toEqual({
      ref: ruleRef(rule(0)),
      action: 'allow',
      process: SAFARI,
      remote: { kind: 'domains', values: ['example.com'] },
      direction: 'outgoing',
      priority: 'regular',
      uid: 501,
      origin: 'frontend',
      protected: false,
      factory: false,
      created: '2026-01-10T09:00:00.000Z',
      modified: '2026-01-10T09:00:00.000Z',
      lastUsed: '2026-11-10T10:40:00.500Z',
      useCount: 42,
    });
  });

  it('names the rule group, using the built-in table when the configuration has no name', () => {
    const all = summaries();
    expect(all[1]?.group).toEqual({ id: 'aaaaad', name: 'Work rules' });
    expect(all[2]?.group).toEqual({ id: 'aaaaab', name: 'macOS Services' });
    expect(all[2]).toMatchObject({ protected: true, factory: true, remote: { kind: 'special', value: 'bonjour' } });
  });

  it('shows fields it does not interpret under "other", without changing them', () => {
    expect(summaries()[3]?.other).toEqual({ futureFlag: '18446744073709551615' });
    expect(summaries()[3]).toMatchObject({ ports: '443', protocol: '6', priority: 'high', remote: { kind: 'any' } });
  });

  it('reads dates written as seconds', () => {
    expect(summaries(sampleModel({ dates: 'cocoa' }))[0]?.created).toBe('2026-01-10T09:00:00.000Z');
  });
});

describe('remoteOf', () => {
  it('reports a rule with no remote at all as unspecified', () => {
    expect(remoteOf({ action: 'allow' })).toEqual({ kind: 'unspecified' });
  });

  it('reads one value and many values alike', () => {
    expect(remoteOf(rule(1))).toEqual({ kind: 'hosts', values: ['telemetry.slack.example', 'metrics.slack.example'] });
    expect(remoteOf({ 'remote-addresses': '10.0.0.1' })).toEqual({ kind: 'addresses', values: ['10.0.0.1'] });
  });
});

describe('semanticKey', () => {
  it('treats a left-out default and a written default as the same rule', () => {
    const terse = { action: 'allow', process: CURL, 'remote-domains': 'example.com' };
    const verbose = { action: 'allow', process: CURL, 'remote-domains': ['example.com'], direction: 'outgoing', priority: 'regular', ports: 'any' };
    expect(semanticKey(terse)).toBe(semanticKey(verbose));
  });

  it('treats a protocol name and its number as the same', () => {
    expect(semanticKey({ action: 'allow', process: CURL, remote: 'any', protocol: 'tcp' })).toBe(
      semanticKey({ action: 'allow', process: CURL, remote: 'any', protocol: '6' }),
    );
  });

  it('ignores order and letter case in the remote list, and how an address list is split', () => {
    expect(semanticKey({ action: 'deny', process: 'any', 'remote-hosts': ['B.example', 'a.example'] })).toBe(
      semanticKey({ action: 'deny', process: 'any', 'remote-hosts': ['a.example', 'b.example'] }),
    );
    expect(semanticKey({ action: 'deny', process: 'any', 'remote-addresses': '10.0.0.1, 10.0.0.2' })).toBe(
      semanticKey({ action: 'deny', process: 'any', 'remote-addresses': ['10.0.0.2', '10.0.0.1'] }),
    );
  });

  it('tells allow from deny, and one process or direction from another', () => {
    const base = { action: 'allow', process: CURL, 'remote-domains': 'example.com' };
    expect(semanticKey(base)).not.toBe(semanticKey({ ...base, action: 'deny' }));
    expect(semanticKey(base)).not.toBe(semanticKey({ ...base, process: SAFARI }));
    expect(semanticKey(base)).not.toBe(semanticKey({ ...base, direction: 'incoming' }));
    expect(semanticKey(base)).not.toBe(semanticKey({ ...base, 'remote-domains': 'example.org' }));
  });
});

describe('tolerantKey', () => {
  const sent = { action: 'deny', creationDate: '2026-11-22T16:00:00Z', modificationDate: '2026-11-22T16:00:00Z', origin: 'frontend', uid: numberValue(501), process: CURL, 'remote-domains': 'example.com', protocol: 'tcp' };

  it('is the same for the respellings Little Snitch may make', () => {
    const back = { ...sent, creationDate: numberValue(817056000), modificationDate: numberValue(817056009), protocol: '6', direction: 'outgoing', priority: 'regular', ports: 'any', 'remote-domains': ['EXAMPLE.com'], lastUsed: numberValue(1), useCount: numberValue(2) };
    expect(tolerantKey(back)).toBe(tolerantKey(sent));
  });

  it('does not respell a remote list that holds anything but text', () => {
    const odd = parseModelText('{"rules":[{"action":"deny","process":"any","remote-domains":["a.example",{"x":1}]},{"action":"deny","process":"any","remote-domains":["a.example"]}]}');
    const [withObject, plain] = rulesOf(odd);
    expect(tolerantKey(withObject!)).not.toBe(tolerantKey(plain!));
  });

  it('differs for every field that carries meaning, known or not', () => {
    const base = tolerantKey(sent);
    const variants = [
      { ...sent, action: 'allow' }, { ...sent, uid: numberValue(0) }, { ...sent, origin: 'factory' }, { ...sent, process: SAFARI },
      { ...sent, 'remote-domains': 'example.org' }, { ...sent, protocol: 'udp' }, { ...sent, direction: 'incoming' }, { ...sent, priority: 'high' },
      { ...sent, ports: '443' }, { ...sent, notes: 'x' }, { ...sent, group: 'g' }, { ...sent, disabled: true }, { ...sent, profile: 'p' }, { ...sent, via: CURL },
    ];
    expect(variants.map((variant) => tolerantKey(variant) === base)).toEqual(variants.map(() => false));
  });
});

describe('filterRules', () => {
  const all = summaries();
  const processes = (filter: Parameters<typeof filterRules>[1]) => filterRules(all, filter, NOW).map((entry) => entry.process);

  it('filters by process, remote, action and group', () => {
    expect(processes({ process: 'slack' })).toEqual([SLACK]);
    expect(processes({ remote: 'EXAMPLE.com' })).toEqual([SAFARI]);
    expect(processes({ action: 'deny' })).toEqual([SLACK]);
    expect(processes({ group: 'work rules' })).toEqual([SLACK]);
    expect(processes({ group: 'aaaaab' })).toEqual(['any']);
    expect(processes({ text: 'telemetry' })).toEqual([SLACK]);
  });

  it('finds a rule for any process with a trusted signature when the filter asks for "any"', () => {
    const signed = summarizeRule({ action: 'deny', requiresTrustedSignatureForAnyProcess: true, 'remote-domains': 'example.com' }, new Map());
    const plain = summarizeRule({ action: 'deny', process: CURL, 'remote-domains': 'example.com' }, new Map());
    expect(filterRules([signed, plain], { process: 'any' }, NOW)).toEqual([signed]);
    expect(filterRules([signed, plain], { process: 'trusted' }, NOW)).toEqual([signed]);
    expect(filterRules([signed, plain], { process: 'curl' }, NOW)).toEqual([plain]);
  });

  it('finds rules unused for a number of days, counting never-used rules', () => {
    expect(processes({ unusedForDays: 30 })).toEqual([SLACK, 'any', CURL]);
    expect(processes({ unusedForDays: 5 })).toEqual([SAFARI, SLACK, 'any', CURL]);
  });

  it('sorts by use count and by last use', () => {
    expect(processes({ sort: 'use_count' })[0]).toBe(SAFARI);
    expect(processes({ sort: 'last_used' }).slice(0, 2)).toEqual([SAFARI, CURL]);
    expect(processes({ sort: 'process' })[0]).toBe(SAFARI);
  });
});

describe('rule groups', () => {
  it('lists every group with its name, state and number of rules, as Little Snitch 6.5 writes them', () => {
    const other = { updateInterval: 86400, lastUpdateInvalidDomainsCount: 0 };
    expect(summarizeGroups(sampleModel())).toEqual([
      { id: 'aaaaab', name: 'macOS Services', nameSource: 'built-in table', kind: 'builtinMacOSServices', active: true, ruleCount: 1, other },
      { id: 'aaaaac', name: 'iCloud Services', nameSource: 'built-in table', kind: 'builtinICloudServices', active: false, ruleCount: 0, other },
      { id: 'aaaaad', name: 'Work rules', nameSource: 'configuration', kind: 'loadedFromFile', active: true, ruleCount: 1, other },
      { id: 'aaaaae', name: null, nameSource: 'unknown', kind: 'builtinSomethingNew', active: true, ruleCount: 0, other },
    ]);
  });

  it('also reads the older spelling with "kind" and "name"', () => {
    const older = parseModelText('{"groups":{"g1":{"kind":"builtinMacOSServices","name":null,"isActive":true},"g2":{"kind":"local","name":"Mine","isActive":false}}}');
    expect(summarizeGroups(older)).toEqual([
      { id: 'g1', name: 'macOS Services', nameSource: 'built-in table', kind: 'builtinMacOSServices', active: true, ruleCount: 0 },
      { id: 'g2', name: 'Mine', nameSource: 'configuration', kind: 'local', active: false, ruleCount: 0 },
    ]);
  });

  it('finds a group by its exact id, name or kind', () => {
    const model = sampleModel();
    expect(resolveGroup(model, 'aaaaad').name).toBe('Work rules');
    expect(resolveGroup(model, 'iCloud Services').id).toBe('aaaaac');
    expect(resolveGroup(model, 'builtinMacOSServices').id).toBe('aaaaab');
  });

  it('does not guess at a misspelled group or one in another letter case', () => {
    expect(() => resolveGroup(sampleModel(), 'Work rule')).toThrow(/No rule group or blocklist is called "Work rule"/);
    expect(() => resolveGroup(sampleModel(), 'work RULES')).toThrow(/Names must match exactly, including letter case/);
  });

  it('refuses a name two groups share', () => {
    const model = parseModelText('{"groups":{"a":{"name":"Same"},"b":{"name":"Same"}}}');
    expect(() => resolveGroup(model, 'Same')).toThrow(/matches 2 rule groups/);
  });
});

describe('profiles', () => {
  it('lists profiles and keeps fields it does not interpret', () => {
    expect(summarizeProfiles(sampleModel())).toEqual([
      { id: 'p1', name: 'Home' },
      { id: 'p2', name: 'Work', other: { silentMode: 1 } },
    ]);
  });

  it('reads the active profile from the user\'s preferences when the key is there', () => {
    expect(activeProfile(sampleModel(), 501)).toEqual({ known: true, name: 'Work', source: 'users[uid 501].defaults.activeProfile' });
  });

  it('says so when the configuration does not tell which profile is active', () => {
    expect(activeProfile(parseModelText('{"profiles":{"p1":{"name":"Home"}},"users":[{"uid":501,"defaults":{}}]}'), 501)).toEqual({ known: false });
  });

  it('reports no active profile when the key is empty', () => {
    expect(activeProfile(parseModelText('{"profiles":{},"globalDefaults":{"activeProfile":null}}'), 501)).toEqual({
      known: true,
      name: null,
      source: 'globalDefaults.activeProfile',
    });
  });

  it('finds a profile only by its exact name', () => {
    expect(resolveProfile(sampleModel(), 'Work').id).toBe('p2');
    expect(() => resolveProfile(sampleModel(), 'work')).toThrow(/No profile is called "work"/);
  });
});
