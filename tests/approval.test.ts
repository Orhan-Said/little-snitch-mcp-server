import { describe, expect, it } from 'vitest';
import { assertFitsPrompt, describeChanges, hasHiddenCharacters, MAX_REMOTE_TEXT, prompts, remoteText, ruleText, shown, unshowable } from '../src/approval.js';
import { validateNewRule } from '../src/model/edit.js';
import { numberValue, parseModelText, rulesOf } from '../src/model/json.js';

const SLACK = '/Applications/Slack.app/Contents/MacOS/Slack';

describe('shown', () => {
  it('leaves an ordinary text alone', () => {
    expect(shown(SLACK)).toBe(SLACK);
  });

  it('keeps the beginning and the end of a long text', () => {
    const long = `/Applications/${'Deep/'.repeat(60)}Contents/MacOS/Tool`;
    const text = shown(long);
    expect(text).toHaveLength(160);
    expect(text.startsWith('/Applications/Deep/')).toBe(true);
    expect(text.endsWith('/Contents/MacOS/Tool')).toBe(true);
    expect(text).toContain(' ... ');
  });

  it('replaces characters that hide or reorder text', () => {
    expect(shown('evil‮gpj.exe')).toBe('evil?gpj.exe');
    expect(shown('a​b\u0007c d')).toBe('a?b?c?d');
    expect(hasHiddenCharacters('plain text')).toBe(false);
    expect(hasHiddenCharacters('zero​width')).toBe(true);
  });
});

describe('ruleText and the prompts', () => {
  it('puts the action and the remote before the process', () => {
    expect(ruleText({ action: 'deny', process: SLACK, 'remote-domains': 'tracker.example' })).toBe(
      `DENY connections to the domains tracker.example for ${SLACK}`,
    );
  });

  it('names every option that narrows or widens the rule', () => {
    expect(
      ruleText({ action: 'allow', process: 'any', via: '/sbin/ping', remote: 'local-net', direction: 'incoming', ports: '8000-8100', protocol: 'tcp', priority: 'high' }),
    ).toBe('ALLOW incoming connections from the "local-net" remotes for ANY process via /sbin/ping (ports 8000-8100, protocol tcp, high priority)');
    expect(ruleText({ action: 'allow', process: SLACK, remote: 'any' })).toBe(`ALLOW connections to ANY remote for ${SLACK}`);
  });

  it('words a rule for both directions and one for any signed process', () => {
    expect(ruleText({ action: 'allow', process: SLACK, remote: 'local-net', direction: 'both' })).toBe(`ALLOW connections in both directions with the "local-net" remotes for ${SLACK}`);
    expect(ruleText({ action: 'allow', requiresTrustedSignatureForAnyProcess: true, remote: 'any' })).toBe('ALLOW connections to ANY remote for ANY process with a trusted signature');
    expect(ruleText({ action: 'deny', remote: 'any' })).toBe('DENY connections to ANY remote for an unspecified process');
  });

  it('still shows the whole remote when the process path is very long', () => {
    const rule = { action: 'allow', process: `/Applications/${'A'.repeat(400)}/Contents/MacOS/Tool`, 'remote-hosts': ['evil-tracker.example', 'second.example'] };
    const prompt = prompts.add(rule);
    expect(prompt.startsWith('Little Snitch MCP wants to ADD a firewall rule: ALLOW connections to the hosts evil-tracker.example, second.example for /Applications/AAAA')).toBe(true);
    expect(prompt.endsWith('/Contents/MacOS/Tool.')).toBe(true);
    expect(prompt.length).toBeLessThan(300);
  });

  it('ends an update prompt with the rule as it will be, so the last action read is the one being approved', () => {
    const before = { action: 'deny', process: SLACK, 'remote-domains': 'example.com', notes: 'old note' };
    const after = { action: 'allow', process: SLACK, 'remote-domains': 'example.com', priority: 'high' };
    expect(describeChanges(before, after)).toEqual(['action DENY becomes ALLOW', 'priority regular becomes high', 'the note is removed']);
    expect(prompts.update(before, after)).toBe(
      'Little Snitch MCP wants to CHANGE a firewall rule (action DENY becomes ALLOW; priority regular becomes high; the note is removed). ' +
        `After the change it will be: ALLOW connections to the domains example.com for ${SLACK} (high priority).`,
    );
  });

  it('shows a note, and names the macOS user of a rule that belongs to someone else', () => {
    const rule = { action: 'allow', process: SLACK, 'remote-domains': 'example.com', uid: numberValue(502), notes: 'approved by the owner' };
    expect(ruleText(rule, 501)).toBe(`ALLOW connections to the domains example.com for ${SLACK}, a rule of macOS user 502, with the note "approved by the owner"`);
    expect(ruleText(rule, 502)).toBe(`ALLOW connections to the domains example.com for ${SLACK}, with the note "approved by the owner"`);
    expect(prompts.update(rule, { ...rule, notes: 'new text' }, 502)).toContain('(the note changes). After the change it will be:');
    expect(prompts.update(rule, { ...rule, notes: 'new text' }, 502)).toContain('with the note "new text"');
  });

  it('states a removal and how much a restore replaces', () => {
    const rule = { action: 'allow', process: SLACK, 'remote-domains': 'example.com' };
    expect(prompts.remove(rule)).toBe(`Little Snitch MCP wants to REMOVE a firewall rule: ALLOW connections to the domains example.com for ${SLACK}.`);
    expect(prompts.restore('20261122T160000Z-manual-abcdef.json', 3, 1, 0)).toBe(
      'Little Snitch MCP wants to REPLACE your whole Little Snitch configuration with the backup 20261122T160000Z-manual-abcdef.json: 3 rule(s) would go, 1 would come back.',
    );
    expect(prompts.restore('b.json', 0, 0, 2)).toContain('2 other part(s) such as preferences or groups would change');
  });
});

describe('remoteText and assertFitsPrompt', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => `host-number-${index}.example.com`);

  it('shows a short list whole', () => {
    expect(remoteText({ 'remote-addresses': ['10.0.0.1', '10.0.0.0/8'] })).toEqual({ text: 'the addresses 10.0.0.1, 10.0.0.0/8', complete: true });
    expect(() => assertFitsPrompt({ 'remote-hosts': many(10) })).not.toThrow();
  });

  it('says how many are left out of a long list, and refuses a new rule with such a list', () => {
    const { text, complete } = remoteText({ 'remote-hosts': many(60) });
    expect(complete).toBe(false);
    expect(text.length).toBeLessThanOrEqual(MAX_REMOTE_TEXT);
    expect(text).toMatch(/^the hosts host-number-0\.example\.com, .* and \d+ more$/);
    expect(() => assertFitsPrompt({ 'remote-hosts': many(60) })).toThrow(/more remotes than fit into one approval prompt.*Split it into several rules/);
    expect(() => assertFitsPrompt({ 'remote-hosts': many(60) }, true)).toThrow(/Change or remove it in Little Snitch itself/);
  });
});

describe('validateNewRule and hidden characters', () => {
  it('refuses a process path or a note with invisible or reordering characters', () => {
    expect(() => validateNewRule({ action: 'allow', process: '/Applications/Safe‮/Tool', remoteDomains: ['example.com'] })).toThrow(/absolute path/);
    expect(() => validateNewRule({ action: 'allow', process: SLACK, remoteDomains: ['example.com'], notes: 'fine​' })).toThrow(/invisible characters/);
    expect(() => validateNewRule({ action: 'allow', process: SLACK, remoteDomains: ['example.com'], notes: 'two\nlines' })).toThrow(/one line/);
  });
});

describe('unshowable: a rule the prompt could not show exactly', () => {
  const base = { action: 'allow', process: SLACK };
  /** A rule as Little Snitch might hold it, read the way the server reads a configuration. */
  const stored = (json: string) => rulesOf(parseModelText(`{"rules":[${json}]}`))[0] ?? {};

  it('finds nothing wrong with the rules the prompt can show', () => {
    expect(unshowable({ ...base, 'remote-domains': 'example.com' })).toBeUndefined();
    expect(unshowable({ ...base, 'remote-hosts': ['a.example', 'b.example'], direction: 'both', ports: '8000-8100', protocol: '6', priority: 'high', notes: 'fine' })).toBeUndefined();
    expect(unshowable({ action: 'deny', remote: 'local-net' })).toBeUndefined();
    expect(unshowable(stored('{"action":"allow","process":"/usr/bin/curl","remote":"any","ports":443,"protocol":6}'))).toBeUndefined();
  });

  it('shows a port or protocol that is stored as a number', () => {
    expect(ruleText(stored('{"action":"allow","process":"/usr/bin/curl","remote":"any","ports":443,"protocol":6}'))).toBe(
      'ALLOW connections to ANY remote for /usr/bin/curl (ports 443, protocol 6)',
    );
  });

  it('refuses a remote list with an entry that is not text, which the prompt would leave out', () => {
    const rule = stored('{"action":"allow","process":"/usr/bin/curl","remote-hosts":["shown.example",{"host":"hidden.example"},7]}');
    expect(unshowable(rule)).toBe('a "remote-hosts" value that is not text or a list of texts');
    expect(() => assertFitsPrompt(rule, true)).toThrow(/could not show you exactly what the rule is\. Change or remove it in Little Snitch itself/);
  });

  it('refuses a rule with two remote fields, of which the prompt would show one', () => {
    expect(unshowable({ ...base, 'remote-domains': 'shown.example', 'remote-addresses': ['203.0.113.9'] })).toBe('more than one remote field (remote-domains, remote-addresses)');
    expect(unshowable({ ...base, remote: 'any', 'remote-hosts': 'x.example' })).toContain('more than one remote field');
  });

  it('refuses a remote field it does not know', () => {
    expect(unshowable({ ...base, 'remote-countries': ['XX'] })).toBe('a remote field this server does not know ("remote-countries")');
  });

  it('refuses a remote that would be cut or printed differently', () => {
    expect(unshowable({ ...base, remote: `local-net${'x'.repeat(40)}` })).toContain('"remote" entry');
    expect(remoteText({ ...base, remote: `local-net${'x'.repeat(40)}` }).complete).toBe(false);
    expect(unshowable({ ...base, remote: ['any'] })).toBe('a "remote" value that is not text or a list of texts');
    expect(unshowable({ ...base, 'remote-hosts': [`${'a'.repeat(254)}.example`] })).toContain('"remote-hosts" entry');
    expect(unshowable({ ...base, 'remote-hosts': ['evil\u202egpj.example'] })).toContain('hidden characters');
    expect(unshowable({ ...base, 'remote-hosts': ['two  spaces.example'] })).toContain('unusual spaces');
    expect(unshowable({ ...base, 'remote-hosts': [] })).toContain('not text or a list of texts');
    expect(unshowable({ ...base, 'remote-hosts': [''] })).toContain('empty');
  });

  it('refuses the other fields the prompt prints when they would be left out or cut', () => {
    expect(unshowable({ ...base, remote: 'any', direction: 'sideways' })).toBe('a direction this server does not know');
    expect(unshowable({ ...base, remote: 'any', priority: 'highest' })).toBe('a priority this server does not know');
    expect(unshowable({ ...base, remote: 'any', ports: ['443', '80'] })).toBe('a "ports" value that cannot be shown exactly');
    expect(unshowable({ ...base, remote: 'any', ports: '1'.repeat(41) })).toBe('a "ports" value that cannot be shown exactly');
    expect(unshowable({ ...base, remote: 'any', protocol: true })).toBe('a "protocol" value that cannot be shown exactly');
    expect(unshowable({ action: 'allow-but-with-a-very-long-name', remote: 'any' })).toBe('a "action" value that cannot be shown exactly');
    expect(unshowable({ action: 'allow', process: '/Applications/Safe\u202e/Tool', remote: 'any' })).toBe('a "process" value that is not plain text');
    expect(unshowable({ ...base, via: ['/sbin/ping'], remote: 'any' })).toBe('a "via" value that is not plain text');
    expect(unshowable({ ...base, remote: 'any', notes: ['a list'] })).toBe('notes that are not text');
  });

  it('still lets a long process path through, which the prompt shows by its beginning and its end', () => {
    expect(unshowable({ action: 'allow', process: `/Applications/${'A'.repeat(400)}/Contents/MacOS/Tool`, remote: 'any' })).toBeUndefined();
  });
});
