import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFitsPrompt, hasHiddenCharacters, MAX_REMOTE_TEXT, prompts, remoteText, ruleText, shown } from '../src/approval.js';
import { createChangeQueue } from '../src/context.js';
import { validateNewRule } from '../src/model/edit.js';
import { createStore } from '../src/store.js';

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

  it('still shows the whole remote when the process path is very long', () => {
    const rule = { action: 'allow', process: `/Applications/${'A'.repeat(400)}/Contents/MacOS/Tool`, 'remote-hosts': ['evil-tracker.example', 'second.example'] };
    const prompt = prompts.add(rule);
    expect(prompt.startsWith('Little Snitch MCP wants to ADD a firewall rule: ALLOW connections to the hosts evil-tracker.example, second.example for /Applications/AAAA')).toBe(true);
    expect(prompt.endsWith('/Contents/MacOS/Tool.')).toBe(true);
    expect(prompt.length).toBeLessThan(300);
  });

  it('says what changes in an update, and how much a restore replaces', () => {
    const rule = { action: 'allow', process: SLACK, 'remote-domains': 'example.com' };
    expect(prompts.update(rule, ['action ALLOW becomes DENY', 'notes change'])).toBe(
      `Little Snitch MCP wants to CHANGE a firewall rule (action ALLOW becomes DENY; notes change). The rule now: ALLOW connections to the domains example.com for ${SLACK}.`,
    );
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
    expect(() => assertFitsPrompt({ 'remote-hosts': many(60) })).toThrow(/more remotes than fit into one approval prompt/);
  });
});

describe('validateNewRule and hidden characters', () => {
  it('refuses a process path or a note with invisible or reordering characters', () => {
    expect(() => validateNewRule({ action: 'allow', process: '/Applications/Safe‮/Tool', remoteDomains: ['example.com'] })).toThrow(/absolute path/);
    expect(() => validateNewRule({ action: 'allow', process: SLACK, remoteDomains: ['example.com'], notes: 'fine​' })).toThrow(/invisible characters/);
    expect(() => validateNewRule({ action: 'allow', process: SLACK, remoteDomains: ['example.com'], notes: 'two\nlines' })).toThrow(/one line/);
  });
});

describe('the change lock', () => {
  let dir: string | undefined;
  const fresh = (): string => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-lock-'));
    return path.join(dir, 'data');
  };
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is held by one change at a time and can be taken again once given back', async () => {
    const store = createStore(fresh(), () => new Date('2026-11-22T16:00:00Z'));
    const release = await store.lock();
    await expect(store.lock()).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('2026-11-22T16:00:00.000Z') });
    await release();
    const again = await store.lock();
    await again();
  });

  it('is refused while another running server holds it', async () => {
    const dataDir = fresh();
    const store = createStore(dataDir, () => new Date('2026-11-22T16:00:00Z'));
    await (await store.lock())();
    writeFileSync(path.join(dataDir, 'change.lock'), JSON.stringify({ pid: process.ppid, since: '2026-11-22T15:59:00.000Z' }));
    await expect(store.lock()).rejects.toMatchObject({ kind: 'busy' });
  });

  it('is taken over from a server that is gone or that held it far too long', async () => {
    const dataDir = fresh();
    const store = createStore(dataDir, () => new Date('2026-11-22T16:00:00Z'));
    await (await store.lock())();
    const lockFile = path.join(dataDir, 'change.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_646, since: '2026-11-22T15:59:00.000Z' }));
    await (await store.lock())();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, since: '2026-11-22T15:00:00.000Z' }));
    await (await store.lock())();
    writeFileSync(lockFile, 'not json');
    const release = await store.lock();
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toEqual({ pid: process.pid, since: '2026-11-22T16:00:00.000Z' });
    await release();
  });
});

describe('createChangeQueue', () => {
  it('runs changes one after another, in the order they were asked for', async () => {
    const events: string[] = [];
    let held = false;
    const queue = createChangeQueue({
      lock: async () => {
        expect(held).toBe(false);
        held = true;
        return async () => {
          held = false;
        };
      },
    });
    const change = (name: string, ms: number) =>
      queue.run(async () => {
        events.push(`${name} starts`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`${name} ends`);
        return name;
      });
    const results = await Promise.all([change('first', 30), change('second', 1), change('third', 1)]);
    expect(results).toEqual(['first', 'second', 'third']);
    expect(events).toEqual(['first starts', 'first ends', 'second starts', 'second ends', 'third starts', 'third ends']);
  });

  it('gives the lock back and carries on after a change that failed', async () => {
    let releases = 0;
    const queue = createChangeQueue({ lock: async () => async () => { releases += 1; } });
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 'next')).toBe('next');
    expect(releases).toBe(2);
  });

  it('does not start a change while another server holds the lock', async () => {
    let started = false;
    const queue = createChangeQueue({ lock: async () => { throw new Error('busy'); } });
    await expect(queue.run(async () => { started = true; })).rejects.toThrow('busy');
    expect(started).toBe(false);
  });
});
