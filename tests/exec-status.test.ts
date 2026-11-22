import { describe, expect, it } from 'vitest';
import { OSASCRIPT_PATH, SUDO_PATH } from '../src/cli/elevation.js';
import { CODESIGN_PATH } from '../src/cli/binary.js';
import { childEnvironment, execFile } from '../src/cli/exec.js';
import { loadConfig } from '../src/config.js';
import { createContext, currentUid } from '../src/context.js';
import { readStatus } from '../src/tools/status.js';
import { fakeExec, SUDO_NEEDS_PASSWORD, type Responder } from './helpers/fakeExec.js';

describe('execFile', () => {
  it('returns output, error text and the exit code', async () => {
    const result = await execFile('/bin/sh', ['-c', 'printf out; printf err 1>&2; exit 3'], { timeoutMs: 5000 });
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err', timedOut: false, overflow: false });
  });

  it('stops a command that runs too long', async () => {
    const started = Date.now();
    const result = await execFile('/bin/sleep', ['5'], { timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops a detached command and its group when it runs too long', async () => {
    const result = await execFile('/bin/sh', ['-c', 'sleep 5 & wait'], { timeoutMs: 150, detached: true });
    expect(result.timedOut).toBe(true);
  });

  it('stops reading when a command prints more than the limit', async () => {
    const result = await execFile('/usr/bin/yes', [], { timeoutMs: 5000, maxBytes: 4096 });
    expect(result.overflow).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });

  it('reports a program that does not exist', async () => {
    const result = await execFile('/nonexistent/program', [], { timeoutMs: 1000 });
    expect(result.code).toBeNull();
    expect(result.spawnError).toContain('ENOENT');
  });

  it('gives the child a fixed environment and nothing from the caller', async () => {
    process.env['LSMCP_TEST_SECRET'] = 'should-not-leak';
    const result = await execFile('/usr/bin/env', [], { timeoutMs: 5000 });
    delete process.env['LSMCP_TEST_SECRET'];
    const names = result.stdout.split('\n').filter((line) => line !== '').map((line) => line.split('=')[0]).sort();
    expect(result.stdout).not.toContain('should-not-leak');
    expect(names.filter((name) => !['HOME', 'USER', 'LOGNAME', 'TMPDIR'].includes(name ?? ''))).toEqual(['LANG', 'LC_ALL', 'PATH']);
  });
});

describe('childEnvironment', () => {
  it('keeps only the home, user and temp folder variables', () => {
    expect(childEnvironment({ HOME: '/Users/x', PATH: '/evil', ANTHROPIC_API_KEY: 'k', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' })).toEqual({
      HOME: '/Users/x',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    });
  });
});

describe('currentUid', () => {
  it('is the process user, or the user who ran sudo when the process is root', () => {
    expect(currentUid({}, 501)).toBe(501);
    expect(currentUid({ SUDO_UID: '502' }, 0)).toBe(502);
    expect(currentUid({ SUDO_UID: '502' }, 501)).toBe(501);
    expect(currentUid({ SUDO_UID: 'abc' }, 0)).toBe(0);
  });
});

/** Runs get_status against a pretend Mac where only the answers of sudo, codesign and the tool vary. */
async function status(argv: readonly string[], options: { touchId: boolean; sudoWorks: boolean; signed?: boolean }): Promise<any> {
  const cliPath = '/bin/ls'; // a root-owned file that exists on every Mac; it is never run for real here
  const responder: Responder = ({ file, args }) => {
    if (file === CODESIGN_PATH) {
      return { code: options.signed === false ? 3 : 0 };
    }
    if (file === SUDO_PATH) {
      return options.sudoWorks ? { stdout: 'Version 6.5\n' } : SUDO_NEEDS_PASSWORD;
    }
    if (file === cliPath && args[0] === '--version') {
      return { stdout: 'Version 6.5\n' };
    }
    if (file === cliPath && args[0] === 'restrictions') {
      return { stdout: 'No restrictions.\n' };
    }
    return file === OSASCRIPT_PATH ? undefined : { code: 1 };
  };
  const { exec, calls } = fakeExec(responder);
  const config = loadConfig({}, ['--cli-path', cliPath, '--data-dir', '/nonexistent/lsmcp', ...argv], '/Users/x');
  const result = await readStatus(createContext(config, { exec, touchId: async () => options.touchId, uid: 501 }));
  expect(calls.some((call) => call.file === OSASCRIPT_PATH)).toBe(false);
  return result;
}

describe('get_status across setups', () => {
  it('explains the password dialog when neither sudo nor Touch ID is ready', async () => {
    const result = await status(['--allow', 'rules'], { touchId: false, sudoWorks: false });
    expect(result.littleSnitch.signature).toBe('valid (Objective Development)');
    expect(result.rootAccess).toEqual({
      mode: 'auto',
      sudoRunsWithoutAsking: false,
      touchIdForSudo: false,
      approvalForReads: 'the macOS administrator password dialog, for each read',
      approvalForChanges: 'the macOS administrator password dialog, for each change',
    });
    expect(result.toDo).toHaveLength(1);
    expect(result.toDo[0]).toContain('Optional: set up Touch ID for sudo');
  });

  it('uses Touch ID for reading only: a change still goes through the password dialog', async () => {
    const result = await status(['--allow', 'switches'], { touchId: true, sudoWorks: false });
    expect(result.rootAccess.approvalForReads).toBe('Touch ID (macOS may not ask again for a few minutes)');
    expect(result.rootAccess.approvalForChanges).toBe('the macOS administrator password dialog, for each change');
    expect(result.toDo).toEqual([]);
  });

  it('still asks for each change when sudo runs without asking, and warns about that sudo rule', async () => {
    const result = await status(['--allow', 'rules'], { touchId: true, sudoWorks: true });
    expect(result.rootAccess.approvalForReads).toBe('none: sudo runs the tool without asking');
    expect(result.rootAccess.approvalForChanges).toBe('the macOS administrator password dialog, for each change');
    expect(result.toDo).toHaveLength(1);
    expect(result.toDo[0]).toContain('sudo runs the Little Snitch tool without asking');
  });

  it('says in capitals that changes need no approval with unattended writes and a sudo that does not ask', async () => {
    const result = await status(['--allow', 'rules', '--unattended-writes'], { touchId: false, sudoWorks: true });
    expect(result.rootAccess.approvalForChanges).toBe('NONE: unattended writes are switched on and sudo runs the tool without asking');
  });

  it('describes unattended writes with Touch ID as possibly without any prompt', async () => {
    const result = await status(['--allow', 'rules', '--unattended-writes'], { touchId: true, sudoWorks: false });
    expect(result.rootAccess.approvalForChanges).toBe(
      'unattended writes are switched on: Touch ID, or no prompt at all while an earlier approval is still remembered',
    );
  });

  it('says that elevation "sudo" cannot guarantee an approval for a change', async () => {
    const result = await status(['--elevation', 'sudo', '--allow', 'rules'], { touchId: true, sudoWorks: false });
    expect(result.rootAccess.approvalForReads).toBe('Touch ID (macOS may not ask again for a few minutes)');
    expect(result.rootAccess.approvalForChanges).toBe(
      'not possible: elevation "sudo" cannot make sure each change is approved; use "auto" or "dialog", or switch on unattended writes',
    );
  });

  it('says what is missing with elevation "sudo" and no Touch ID', async () => {
    const result = await status(['--elevation', 'sudo', '--allow', 'rules'], { touchId: false, sudoWorks: false });
    expect(result.rootAccess.approvalForReads).toContain('not possible yet');
    expect(result.rootAccess.approvalForChanges).toContain('not possible:');
    expect(result.toDo[0]).toContain('Touch ID for sudo');
  });

  it('says in capitals that elevation "none" asks nobody', async () => {
    const result = await status(['--elevation', 'none', '--allow', 'rules'], { touchId: false, sudoWorks: false });
    expect(result.rootAccess.approvalForChanges).toBe('NONE: with elevation "none" the tool is run directly and nobody is asked');
    expect(result.toDo).toEqual(['Elevation "none" is meant for tests: the assistant can make the allowed changes without anyone approving them.']);
  });

  it('always uses the dialog with elevation "dialog" and never probes sudo', async () => {
    const result = await status(['--elevation', 'dialog', '--allow', 'rules'], { touchId: true, sudoWorks: true });
    expect(result.rootAccess.sudoRunsWithoutAsking).toBe(false);
    expect(result.rootAccess.approvalForReads).toBe('the macOS administrator password dialog, for each read');
    expect(result.rootAccess.approvalForChanges).toBe('the macOS administrator password dialog, for each change');
  });

  it('says that unattended writes have no effect with elevation "dialog"', async () => {
    const result = await status(['--elevation', 'dialog', '--allow', 'rules', '--unattended-writes'], { touchId: true, sudoWorks: true });
    expect(result.rootAccess.approvalForChanges).toBe(
      'the macOS administrator password dialog, for each change (unattended writes have no effect with elevation "dialog")',
    );
  });

  it('flags a tool that fails the signature check and does not run it through sudo', async () => {
    const result = await status([], { touchId: false, sudoWorks: true, signed: false });
    expect(result.littleSnitch.signature).toBe('INVALID');
    expect(result.rootAccess.sudoRunsWithoutAsking).toBe(false);
    expect(result.toDo[0]).toContain('is not signed by Objective Development');
  });

  it('reports a missing Little Snitch', async () => {
    const { exec } = fakeExec(() => ({ code: 1 }));
    const config = loadConfig({}, ['--cli-path', '/nonexistent/littlesnitch', '--data-dir', '/nonexistent/lsmcp'], '/Users/x');
    const result: any = await readStatus(createContext(config, { exec, touchId: async () => false }));
    expect(result.littleSnitch).toMatchObject({ installed: false, version: null });
    expect(result.terminalAccess).toBe('unknown');
    expect(result.toDo[0]).toContain('Install Little Snitch 6');
  });
});
