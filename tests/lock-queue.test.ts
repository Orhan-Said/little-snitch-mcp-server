import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changingCommandRunning, showsChangingCommand } from '../src/cli/running.js';
import { execFile } from '../src/cli/exec.js';
import { loadConfig } from '../src/config.js';
import { createChangeQueue } from '../src/context.js';
import { acquireKernelLock, SYSTEM_LOCK_FILE, type LockHandle } from '../src/lock.js';
import { fakeExec } from './helpers/fakeExec.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) {
    await sleep(20);
  }
}

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

  it('has one place for the whole Mac, whatever the home folder and the data folder are', () => {
    expect(SYSTEM_LOCK_FILE).toBe('/private/var/tmp/little-snitch-mcp-server.lock');
    const first = loadConfig({ HOME: '/Users/one' }, ['--data-dir', '/tmp/one'], '/Users/one');
    const second = loadConfig({ HOME: '/Users/two', LITTLE_SNITCH_MCP_DATA_DIR: '/tmp/two' }, [], '/Users/two');
    expect(first.lockFile).toBe(SYSTEM_LOCK_FILE);
    expect(second.lockFile).toBe(SYSTEM_LOCK_FILE);
  });

  it('is held by one taker at a time and can be taken again once given back', async () => {
    const file = lockFile();
    const lock = await acquireKernelLock(file);
    expect(existsSync(file)).toBe(true);
    expect(lock.isHeld()).toBe(true);
    await expect(acquireKernelLock(file)).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('Another change to Little Snitch is in progress on this Mac') });
    await lock.release();
    expect(lock.isHeld()).toBe(false);
    const again = await acquireKernelLock(file);
    await again.release();
    await again.release();
  });

  it('makes a lock file that every user of the Mac can open, and locks one it cannot write to', async () => {
    const file = lockFile();
    await (await acquireKernelLock(file)).release();
    expect(statSync(file).mode & 0o777).toBe(0o644);
    // Another user's lock file looks like this to the taker: readable, not writable.
    chmodSync(file, 0o444);
    const lock = await acquireKernelLock(file);
    expect(lock.isHeld()).toBe(true);
    await lock.release();
  });

  it('does not use a link or a folder that sits where the lock file should be', async () => {
    const file = lockFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = path.join(path.dirname(file), 'elsewhere');
    writeFileSync(elsewhere, '');
    symlinkSync(elsewhere, file);
    await expect(acquireKernelLock(file)).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('is not an ordinary file') });
    rmSync(file);
    mkdirSync(file);
    await expect(acquireKernelLock(file)).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('is not an ordinary file') });
  });

  it('lets exactly one of many simultaneous takers through', async () => {
    const file = lockFile();
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireKernelLock(file)));
    const winners = attempts.flatMap((attempt) => (attempt.status === 'fulfilled' ? [attempt.value] : []));
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(11);
    await winners[0]?.release();
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
    let lock: LockHandle | undefined;
    for (let attempt = 0; attempt < 40 && lock === undefined; attempt += 1) {
      lock = await acquireKernelLock(file).catch(() => undefined);
      if (lock === undefined) {
        await sleep(50);
      }
    }
    expect(lock?.isHeld()).toBe(true);
    await lock?.release();
  });

  it('says that it is no longer held once the helper that holds it has died', async () => {
    const file = lockFile();
    const lock = await acquireKernelLock(file);
    expect(lock.isHeld()).toBe(true);
    // The kernel lock belongs to the lockf process. Without it the lock is free, whatever this server believes.
    execFileSync('/usr/bin/pkill', ['-9', '-f', `lockf -k -t 0 ${file}`]);
    await until(() => !lock.isHeld());
    expect(lock.isHeld()).toBe(false);
    const other = await acquireKernelLock(file);
    expect(other.isHeld()).toBe(true);
    await other.release();
    await lock.release();
  });

  it('gives up when the lock cannot be taken in time', async () => {
    const file = lockFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const stuck = path.join(path.dirname(file), 'stuck-lockf');
    writeFileSync(stuck, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(stuck, 0o755);
    const started = Date.now();
    await expect(acquireKernelLock(file, { lockfPath: stuck, acquireTimeoutMs: 200 })).rejects.toMatchObject({
      kind: 'busy',
      message: 'The lock that keeps changes apart could not be taken in time.',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('showsChangingCommand', () => {
  const CLI = '/Applications/Little Snitch.app/Contents/Components/littlesnitch';

  it('sees the tool at work on a change, with or without the user option', () => {
    expect(showsChangingCommand(`${CLI} restore-model --preserve-terminal-access /private/var/root/lsmcp.Ab12/model.json`, CLI)).toBe(true);
    expect(showsChangingCommand(`${CLI} -u 501 restore-model -t /x`, CLI)).toBe(true);
    expect(showsChangingCommand(`${CLI} --user someone profile --activate Home`, CLI)).toBe(true);
    expect(showsChangingCommand(`${CLI} -u 501 rulegroup --disable Work rules`, CLI)).toBe(true);
  });

  it('sees it inside the shell, sudo or osascript that carries the command, where every word is quoted', () => {
    const script = `set -u; d=$(/usr/bin/mktemp -d /private/var/root/lsmcp.XXXXXXXX); '${CLI}' '-u' '501' 'restore-model' '--preserve-terminal-access' "$d/in"`;
    expect(showsChangingCommand(`/bin/sh -c ${script}`, CLI)).toBe(true);
    expect(showsChangingCommand(`/usr/bin/osascript -e on run argv -e do shell script (item 1 of argv) ${script} Little Snitch MCP wants to ADD a firewall rule`, CLI)).toBe(true);
    expect(showsChangingCommand(`sudo -n -- ${CLI} -u 501 restore-model -t /x`, CLI)).toBe(true);
  });

  it('does not count a read, another program, or a word that only looks like a command', () => {
    expect(showsChangingCommand(`${CLI} -u 501 export-model`, CLI)).toBe(false);
    expect(showsChangingCommand(`${CLI} log-traffic --begin-date 2026-11-23 10:00:00`, CLI)).toBe(false);
    expect(showsChangingCommand(`${CLI} log --stream`, CLI)).toBe(false);
    expect(showsChangingCommand(`/usr/bin/osascript -e do shell script '${CLI}' '-u' '501' 'export-model' Little Snitch MCP wants to read your profile list`, CLI)).toBe(false);
    expect(showsChangingCommand('/usr/local/bin/other restore-model x', CLI)).toBe(false);
    expect(showsChangingCommand(`${CLI} -u 501 restore-models`, CLI)).toBe(false);
  });
});

describe('changingCommandRunning', () => {
  it('finds a real process on this Mac whose command line carries a changing command, and stops finding it when it is gone', async () => {
    const cli = path.join(os.tmpdir(), `lsmcp-running-${process.pid}`, 'littlesnitch');
    expect(await changingCommandRunning(execFile, cli)).toBe(false);
    // The words after the script are only arguments: nothing of that name is run.
    const stand = spawn('/bin/sh', ['-c', 'sleep 30; true', cli, '-u', '501', 'restore-model'], { stdio: 'ignore', detached: true });
    try {
      await sleep(200);
      expect(await changingCommandRunning(execFile, cli)).toBe(true);
    } finally {
      // The shell and its sleep, together.
      process.kill(-(stand.pid ?? 0), 'SIGKILL');
      await new Promise((resolve) => stand.on('close', resolve));
    }
    expect(await changingCommandRunning(execFile, cli)).toBe(false);
  });

  it('answers with an error, not with "nothing is running", when the list cannot be read', async () => {
    for (const answer of [{ code: 1 }, { code: null, timedOut: true }, { code: 0, overflow: true }, { code: null, spawnError: 'ENOENT' }]) {
      const { exec } = fakeExec(() => answer);
      await expect(changingCommandRunning(exec, '/x/littlesnitch')).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('could not be read') });
    }
  });
});

/** A lock that counts: how often it was taken and given back, and whether its helper is alive. */
function countingLock() {
  const state = { taken: 0, released: 0, alive: true };
  const lock = async (): Promise<LockHandle> => {
    expect(state.taken - state.released, 'the lock is taken while it is still held').toBe(0);
    state.taken += 1;
    return {
      isHeld: () => state.alive,
      release: async () => {
        state.released += 1;
      },
    };
  };
  return { state, lock };
}
const idle = { commandRunning: async () => false, settleMs: 60_000 };

describe('createChangeQueue', () => {
  it('runs changes one after another, in the order they were asked for', async () => {
    const events: string[] = [];
    const { lock, state } = countingLock();
    const queue = createChangeQueue({ ...idle, lock });
    const change = (name: string, ms: number) =>
      queue.run(async () => {
        events.push(`${name} starts`);
        await sleep(ms);
        events.push(`${name} ends`);
        return name;
      });
    const results = await Promise.all([change('first', 30), change('second', 1), change('third', 1)]);
    expect(results).toEqual(['first', 'second', 'third']);
    expect(events).toEqual(['first starts', 'first ends', 'second starts', 'second ends', 'third starts', 'third ends']);
    expect(state).toMatchObject({ taken: 3, released: 3 });
  });

  it('gives the lock back and carries on after a change that failed', async () => {
    const { lock, state } = countingLock();
    const queue = createChangeQueue({ ...idle, lock });
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 'next')).toBe('next');
    expect(state.released).toBe(2);
  });

  it('does not start a change while another server holds the lock', async () => {
    let started = false;
    const queue = createChangeQueue({ ...idle, lock: async () => { throw new Error('busy'); } });
    await expect(queue.run(async () => { started = true; })).rejects.toThrow('busy');
    expect(started).toBe(false);
  });

  it('keeps the result of a finished change when giving the lock back fails', async () => {
    const queue = createChangeQueue({ ...idle, lock: async () => ({ isHeld: () => true, release: async () => { throw new Error('could not release'); } }) });
    expect(await queue.run(async () => 'done')).toBe('done');
  });

  it('clears what an earlier change left behind, under the lock and before the change', async () => {
    const events: string[] = [];
    const { lock, state } = countingLock();
    const queue = createChangeQueue({
      ...idle,
      lock,
      onLockTaken: async () => {
        events.push(`cleared while ${state.taken - state.released} lock is held`);
      },
    });
    await queue.run(async () => { events.push('change'); });
    expect(events).toEqual(['cleared while 1 lock is held', 'change']);
  });

  it('does not start a change while a command that changes Little Snitch is running, and gives the lock back', async () => {
    let running = true;
    let started = 0;
    const { lock, state } = countingLock();
    const queue = createChangeQueue({ ...idle, lock, commandRunning: async () => running });
    await expect(queue.run(async () => { started += 1; })).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('is running on this Mac right now') });
    expect(started).toBe(0);
    expect(state).toMatchObject({ taken: 1, released: 1 });
    running = false;
    await queue.run(async () => { started += 1; });
    expect(started).toBe(1);
  });

  it('does not start a change when it cannot tell whether such a command is running', async () => {
    const { lock, state } = countingLock();
    const queue = createChangeQueue({ ...idle, lock, commandRunning: async () => { throw new Error('the list could not be read'); } });
    await expect(queue.run(async () => 'never')).rejects.toThrow('the list could not be read');
    expect(state).toMatchObject({ taken: 1, released: 1 });
  });

  it('knows whether the lock of the running change is still held', async () => {
    const { lock, state } = countingLock();
    const queue = createChangeQueue({ ...idle, lock });
    expect(() => queue.assertLockHeld()).toThrow(/lock that keeps changes apart was lost/);
    await queue.run(async () => {
      expect(() => queue.assertLockHeld()).not.toThrow();
      state.alive = false;
      expect(() => queue.assertLockHeld()).toThrow(expect.objectContaining({ kind: 'busy' }));
    });
    expect(() => queue.assertLockHeld()).toThrow();
  });

  describe('after a command that did not end in time', () => {
    it('keeps the lock and refuses every change until the wait is over and the command is gone', async () => {
      let time = 1_000_000;
      let running = true;
      let started = 0;
      const { lock, state } = countingLock();
      const queue = createChangeQueue({ lock, settleMs: 60_000, clock: () => time, commandRunning: async () => running && state.taken === state.released + 1 && queue.waitingForCommand() });
      expect(queue.waitingForCommand()).toBe(false);
      await expect(
        queue.run(async () => {
          queue.commandMayStillRun();
          expect(queue.waitingForCommand()).toBe(true);
          throw new Error('timed out');
        }),
      ).rejects.toThrow('timed out');
      expect(state).toMatchObject({ taken: 1, released: 0 });
      expect(queue.waitingForCommand()).toBe(true);

      time += 20_000;
      await expect(queue.run(async () => { started += 1; })).rejects.toMatchObject({
        kind: 'busy',
        message: expect.stringContaining('changes nothing for another 40 second(s), and nothing while that command runs'),
      });
      // The minute has passed, but the command is still there.
      time += 45_000;
      await expect(queue.run(async () => { started += 1; })).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('is still running') });
      expect(started).toBe(0);
      expect(state).toMatchObject({ taken: 1, released: 0 });

      running = false;
      await queue.run(async () => { started += 1; });
      expect(started).toBe(1);
      expect(queue.waitingForCommand()).toBe(false);
      expect(state).toMatchObject({ taken: 2, released: 2 });
    });

    it('gives the lock back by itself once the wait is over, so other servers are not held up', async () => {
      const { lock, state } = countingLock();
      const queue = createChangeQueue({ lock, settleMs: 40, commandRunning: async () => false });
      await queue.run(async () => { queue.commandMayStillRun(); });
      expect(state).toMatchObject({ taken: 1, released: 0 });
      await until(() => state.released === 1);
      expect(state.released).toBe(1);
      expect(queue.waitingForCommand()).toBe(false);
    });

    it('does not carry the mark over to the next change', async () => {
      const { lock, state } = countingLock();
      let running = false;
      const queue = createChangeQueue({ lock, settleMs: 0, commandRunning: async () => running });
      await queue.run(async () => { queue.commandMayStillRun(); });
      await queue.run(async () => 'second');
      expect(queue.waitingForCommand()).toBe(false);
      // A change that is refused before it starts must not leave the queue waiting either.
      running = true;
      await expect(queue.run(async () => 'third')).rejects.toMatchObject({ kind: 'busy' });
      expect(queue.waitingForCommand()).toBe(false);
      expect(state.taken).toBe(state.released);
    });
  });
});
