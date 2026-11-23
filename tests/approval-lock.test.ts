import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFitsPrompt, describeChanges, hasHiddenCharacters, MAX_REMOTE_TEXT, prompts, remoteText, ruleText, shown } from '../src/approval.js';
import { createChangeQueue } from '../src/context.js';
import { acquireKernelLock } from '../src/lock.js';
import { validateNewRule } from '../src/model/edit.js';
import { numberValue } from '../src/model/json.js';

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

describe('the change lock', () => {
  let dir: string | undefined;
  const lockFile = (): string => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-lock-'));
    return path.join(dir, 'Application Support', 'change.lock');
  };
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is held by one taker at a time and can be taken again once given back', async () => {
    const file = lockFile();
    const release = await acquireKernelLock(file);
    expect(existsSync(file)).toBe(true);
    await expect(acquireKernelLock(file)).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('Another change to Little Snitch is in progress') });
    await release();
    const again = await acquireKernelLock(file);
    await again();
    await again();
  });

  it('lets exactly one of many simultaneous takers through', async () => {
    const file = lockFile();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireKernelLock(file)));
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(11);
    await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it('frees itself when the process that holds it dies, with nothing to clean up', async () => {
    const file = lockFile();
    // Another process holds the lock the same way the server does: lockf runs cat on a pipe that the process keeps open.
    const script =
      `const { spawn } = require('node:child_process');` +
      `const child = spawn('/usr/bin/lockf', ['-k', '-t', '0', ${JSON.stringify(file)}, '/bin/sh', '-c', 'echo held; exec /bin/cat >/dev/null'], { stdio: ['pipe', 'pipe', 'inherit'] });` +
      `child.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) console.log('holding'); });` +
      `child.on('close', () => process.exit(1));` +
      `setInterval(() => {}, 1000);`;
    mkdirSync(path.dirname(file), { recursive: true });
    const holder = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (chunk: Buffer) => (chunk.toString().includes('holding') ? resolve() : undefined));
      holder.on('close', () => reject(new Error('the holder ended before it took the lock')));
    });
    await expect(acquireKernelLock(file)).rejects.toMatchObject({ kind: 'busy' });
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('close', resolve));
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; attempt < 40 && release === undefined; attempt += 1) {
      release = await acquireKernelLock(file).catch(() => undefined);
      if (release === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(release).toBeTypeOf('function');
    await release?.();
  });
});

describe('createChangeQueue', () => {
  it('runs changes one after another, in the order they were asked for', async () => {
    const events: string[] = [];
    let held = false;
    const queue = createChangeQueue(async () => {
      expect(held).toBe(false);
      held = true;
      return async () => {
        held = false;
      };
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
    const queue = createChangeQueue(async () => async () => {
      releases += 1;
    });
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 'next')).toBe('next');
    expect(releases).toBe(2);
  });

  it('does not start a change while another server holds the lock', async () => {
    let started = false;
    const queue = createChangeQueue(async () => { throw new Error('busy'); });
    await expect(queue.run(async () => { started = true; })).rejects.toThrow('busy');
    expect(started).toBe(false);
  });

  it('keeps the result of a finished change when giving the lock back fails', async () => {
    const queue = createChangeQueue(async () => async () => { throw new Error('could not release'); });
    expect(await queue.run(async () => 'done')).toBe('done');
  });
});
