import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifySudo, createElevator, OSASCRIPT_PATH, SUDO_PATH, touchIdConfigured, type ElevationDeps, type Step } from '../../src/cli/elevation.js';
import type { ElevationMode } from '../../src/config.js';
import { LittleSnitchError } from '../../src/errors.js';
import { fakeExec, result, SUDO_NEEDS_PASSWORD, SUDO_NO_TERMINAL, type Responder } from '../helpers/fakeExec.js';

const CLI = '/Applications/Little Snitch.app/Contents/Components/littlesnitch';
const TOKEN = 'abcdefghijklmnop0123';
const PENDING = '/data/pending/change.json';
const PENDING_TEXT = '{"rules":[]}';
const PENDING_SHA = createHash('sha256').update(PENDING_TEXT).digest('hex');

const RESTORE: Step = { args: ['restore-model', '--preserve-terminal-access', PENDING], write: true, input: { index: 2, sha256: PENDING_SHA } };
const EXPORT: Step = { args: ['export-model'] };

function setup(options: { mode: ElevationMode; touchId?: boolean; unattended?: boolean; responder: Responder; fileText?: string | null }) {
  const { exec, calls } = fakeExec(options.responder);
  const deps: ElevationDeps = {
    exec,
    config: { cliPath: CLI, elevation: options.mode, unattendedWrites: options.unattended ?? false, interactiveTimeoutMs: 300_000, commandTimeoutMs: 60_000 },
    touchIdConfigured: async () => options.touchId ?? false,
    randomToken: () => TOKEN,
    readFile: async () => {
      if (options.fileText === null) {
        throw new Error('ENOENT');
      }
      return Buffer.from(options.fileText ?? PENDING_TEXT);
    },
  };
  return { elevator: createElevator(deps), calls };
}

function dialogOutput(steps: ReadonlyArray<{ code: number; stdout: string; stderr?: string }>): string {
  return steps.map((step) => `${step.stdout}\n${TOKEN} ${step.code}\n${step.stderr ?? ''}\n${TOKEN}-end\n`).join('') + '\n';
}

describe('touchIdConfigured', () => {
  it('is true when sudo_local enables pam_tid', async () => {
    const read = async (file: string) => (file.endsWith('sudo_local') ? 'auth       sufficient     pam_tid.so\n' : '');
    expect(await touchIdConfigured(read)).toBe(true);
  });

  it('is false when the line is commented out or the files are missing', async () => {
    expect(await touchIdConfigured(async () => '#auth       sufficient     pam_tid.so\n')).toBe(false);
    expect(await touchIdConfigured(async () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('classifySudo', () => {
  it('tells a sudo refusal from the command\'s own failure', () => {
    expect(classifySudo(result(SUDO_NEEDS_PASSWORD)).kind).toBe('needs-auth');
    expect(classifySudo(result(SUDO_NO_TERMINAL)).kind).toBe('needs-auth');
    expect(classifySudo(result({ code: 1, stderr: 'sudo: someone is not in the sudoers file.\n' })).kind).toBe('not-permitted');
    expect(classifySudo(result({ code: 1, stderr: 'sudo: unable to initialize policy plugin\n' })).kind).toBe('failed');
    expect(classifySudo(result({ code: 1, stderr: 'Rule group or blocklist "X" not found.\n' }))).toEqual({
      kind: 'ran',
      output: { code: 1, stdout: '', stderr: 'Rule group or blocklist "X" not found.\n' },
    });
  });
});

describe('reading', () => {
  it('uses sudo without a prompt when sudo allows it', async () => {
    const { elevator, calls } = setup({ mode: 'auto', responder: () => ({ stdout: '{"rules":[]}' }) });
    const run = await elevator.run([EXPORT], 'reason');
    expect(run).toEqual({ method: 'sudo', steps: [{ code: 0, stdout: '{"rules":[]}', stderr: '' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(SUDO_PATH);
    expect(calls[0]?.args).toEqual(['-n', '--', CLI, 'export-model']);
    expect(calls[0]?.options.detached).toBe(true);
  });

  it('falls back to the administrator dialog when sudo needs a password and Touch ID is not set up', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NEEDS_PASSWORD : { stdout: dialogOutput([{ code: 0, stdout: '{"rules":[]}' }]) }),
    });
    const run = await elevator.run([EXPORT], 'Please allow reading');
    expect(run).toEqual({ method: 'dialog', steps: [{ code: 0, stdout: '{"rules":[]}', stderr: '' }] });
    expect(calls.map((call) => call.file)).toEqual([SUDO_PATH, OSASCRIPT_PATH]);
    expect(calls[1]?.args.at(-1)).toBe('Please allow reading');
    expect(calls[1]?.args.at(-2)).toContain(`'${CLI}' 'export-model'`);
  });

  it('asks Touch ID through sudo when it is set up', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      touchId: true,
      responder: ({ args }) => (args[0] === '-n' ? SUDO_NEEDS_PASSWORD : { stdout: 'ok' }),
    });
    const run = await elevator.run([{ args: ['list-preferences'] }], 'reason');
    expect(run.method).toBe('sudo-interactive');
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([['-n', '--'], ['--', CLI]]);
    expect(calls[1]?.options.timeoutMs).toBe(300_000);
  });

  it('falls back to the administrator dialog when Touch ID through sudo does not work', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      touchId: true,
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NO_TERMINAL : { stdout: dialogOutput([{ code: 0, stdout: '{}' }]) }),
    });
    const run = await elevator.run([EXPORT], 'reason');
    expect(run.method).toBe('dialog');
    expect(calls.map((call) => call.file)).toEqual([SUDO_PATH, SUDO_PATH, OSASCRIPT_PATH]);
  });

  it('reports a cancelled Touch ID as cancelled when the dialog is not allowed', async () => {
    const { elevator } = setup({ mode: 'sudo', touchId: true, responder: () => SUDO_NO_TERMINAL });
    await expect(elevator.run([EXPORT], 'reason')).rejects.toMatchObject({ kind: 'elevation-cancelled' });
  });

  it('reports a cancelled administrator dialog as cancelled', async () => {
    const { elevator } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NEEDS_PASSWORD : { code: 1, stderr: 'execution error: User canceled. (-128)\n' }),
    });
    await expect(elevator.run([EXPORT], 'reason')).rejects.toMatchObject({ kind: 'elevation-cancelled' });
  });

  it('reports an account that may not use sudo', async () => {
    const { elevator } = setup({ mode: 'auto', responder: () => ({ code: 1, stderr: 'sudo: guest is not in the sudoers file.\n' }) });
    await expect(elevator.run([EXPORT], 'reason')).rejects.toMatchObject({ kind: 'elevation-unavailable' });
  });

  it('passes the tool\'s own failure back instead of treating it as a sudo problem', async () => {
    const { elevator } = setup({ mode: 'auto', responder: () => ({ code: 14, stderr: 'littlesnitch must be run as root!\n' }) });
    const run = await elevator.run([EXPORT], 'reason');
    expect(run.steps).toEqual([{ code: 14, stdout: '', stderr: 'littlesnitch must be run as root!\n' }]);
  });

  it('never opens the dialog with elevation "sudo"', async () => {
    const { elevator, calls } = setup({ mode: 'sudo', responder: () => SUDO_NEEDS_PASSWORD });
    const error = await elevator.run([EXPORT], 'reason').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LittleSnitchError);
    expect((error as LittleSnitchError).kind).toBe('elevation-unavailable');
    expect(calls.every((call) => call.file === SUDO_PATH)).toBe(true);
  });
});

describe('changing, when each change needs approval', () => {
  it('goes through the administrator dialog and never through sudo, even when sudo would not ask', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === OSASCRIPT_PATH ? { stdout: dialogOutput([{ code: 0, stdout: '' }, { code: 0, stdout: '{}' }]) } : { stdout: 'sudo would have run this silently' }),
    });
    const run = await elevator.run([RESTORE, EXPORT], 'Approve the change');
    expect(run.method).toBe('dialog');
    expect(run.steps).toHaveLength(2);
    expect(calls.map((call) => call.file)).toEqual([OSASCRIPT_PATH]);
    expect(calls[0]?.args.at(-1)).toBe('Approve the change');
  });

  it('uses the dialog with Touch ID set up as well, because sudo cannot promise a prompt', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      touchId: true,
      responder: ({ file }) => (file === OSASCRIPT_PATH ? { stdout: dialogOutput([{ code: 0, stdout: '' }, { code: 0, stdout: '{}' }]) } : undefined),
    });
    await elevator.run([RESTORE, EXPORT], 'reason');
    expect(calls.map((call) => call.file)).toEqual([OSASCRIPT_PATH]);
  });

  it('has root read the file from a private copy checked against its checksum', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: () => ({ stdout: dialogOutput([{ code: 0, stdout: '' }, { code: 0, stdout: '{}' }]) }),
    });
    await elevator.run([RESTORE, EXPORT], 'reason');
    const script = calls[0]?.args.at(-2) ?? '';
    expect(script).toContain(`/bin/cp '${PENDING}' "$d/input"`);
    expect(script).toContain(`= '${PENDING_SHA}' ]`);
    expect(script).toContain(`'restore-model' '--preserve-terminal-access' "$d/input"`);
    expect(script).not.toContain(`'--preserve-terminal-access' '${PENDING}'`);
  });

  it('refuses with elevation "sudo", which has no prompt it can rely on', async () => {
    const { elevator, calls } = setup({ mode: 'sudo', touchId: true, responder: () => ({ stdout: 'ok' }) });
    await expect(elevator.run([{ args: ['profile', '--deactivate-all'], write: true }], 'reason')).rejects.toMatchObject({
      kind: 'elevation-unavailable',
      message: expect.stringContaining('NOPASSWD'),
    });
    expect(calls).toHaveLength(0);
  });

  it('runs earlier reads through sudo and hands the change and everything after it to one dialog', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? { stdout: 'before' } : { stdout: dialogOutput([{ code: 0, stdout: '' }, { code: 0, stdout: 'after' }]) }),
    });
    const run = await elevator.run([EXPORT, RESTORE, EXPORT], 'reason');
    expect(run.steps.map((step) => step.stdout)).toEqual(['before', '', 'after']);
    expect(calls.map((call) => call.file)).toEqual([SUDO_PATH, OSASCRIPT_PATH]);
  });

  it('returns what already ran when the change is cancelled after an earlier command', async () => {
    const { elevator } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? { stdout: 'before' } : { code: 1, stderr: 'execution error: User canceled. (-128)\n' }),
    });
    const run = await elevator.run([EXPORT, RESTORE], 'reason');
    expect(run.steps).toEqual([{ code: 0, stdout: 'before', stderr: '' }]);
  });
});

describe('changing, with unattended writes switched on', () => {
  it('runs a change through sudo without a prompt when sudo allows it', async () => {
    const { elevator, calls } = setup({ mode: 'auto', unattended: true, responder: () => ({ stdout: 'ok' }) });
    const run = await elevator.run([{ args: ['profile', '--activate', 'Work'], write: true }], 'reason');
    expect(run.method).toBe('sudo');
    expect(calls[0]?.args).toEqual(['-n', '--', CLI, 'profile', '--activate', 'Work']);
  });

  it('checks the file against its checksum right before sudo runs', async () => {
    const good = setup({ mode: 'auto', unattended: true, responder: () => ({ stdout: 'ok' }) });
    await good.elevator.run([RESTORE], 'reason');
    expect(good.calls[0]?.args).toEqual(['-n', '--', CLI, 'restore-model', '--preserve-terminal-access', PENDING]);

    const swapped = setup({ mode: 'auto', unattended: true, fileText: '{"rules":[{"action":"allow"}]}', responder: () => ({ stdout: 'ok' }) });
    await expect(swapped.elevator.run([RESTORE], 'reason')).rejects.toMatchObject({ kind: 'tampered' });
    expect(swapped.calls).toHaveLength(0);

    const gone = setup({ mode: 'none', fileText: null, responder: () => ({ stdout: 'ok' }) });
    await expect(gone.elevator.run([RESTORE], 'reason')).rejects.toMatchObject({ kind: 'tampered' });
    expect(gone.calls).toHaveLength(0);
  });

  it('reports the change as run when the read-back after it cannot get root', async () => {
    const { elevator } = setup({
      mode: 'sudo',
      unattended: true,
      responder: ({ args }) => (args.includes('restore-model') ? { stdout: '' } : SUDO_NEEDS_PASSWORD),
    });
    const run = await elevator.run([RESTORE, EXPORT], 'reason');
    expect(run.steps).toEqual([{ code: 0, stdout: '', stderr: '' }]);
  });
});

describe('elevation "none"', () => {
  it('runs the tool directly and stops at the first failure', async () => {
    const { elevator, calls } = setup({
      mode: 'none',
      responder: ({ args }) => (args[0] === 'restore-model' ? { code: 1, stderr: 'bad file' } : { stdout: '{}' }),
    });
    const run = await elevator.run([RESTORE, EXPORT], 'reason');
    expect(run.method).toBe('direct');
    expect(run.steps).toEqual([{ code: 1, stdout: '', stderr: 'bad file' }]);
    expect(calls.map((call) => call.file)).toEqual([CLI]);
  });
});

describe('elevation "dialog"', () => {
  it('uses one dialog for all commands', async () => {
    const { elevator, calls } = setup({
      mode: 'dialog',
      responder: () => ({ stdout: dialogOutput([{ code: 0, stdout: 'a' }, { code: 3, stdout: '', stderr: 'boom' }]) }),
    });
    const run = await elevator.run([{ args: ['one'] }, { args: ['two'] }, { args: ['three'] }], 'reason');
    expect(run.steps).toEqual([{ code: 0, stdout: 'a', stderr: '' }, { code: 3, stdout: '', stderr: 'boom' }]);
    expect(calls).toHaveLength(1);
  });

  it('fails when the dialog returns nothing readable', async () => {
    const { elevator } = setup({ mode: 'dialog', responder: () => ({ stdout: 'garbage' }) });
    await expect(elevator.run([{ args: ['one'] }], 'reason')).rejects.toMatchObject({ kind: 'unexpected-output' });
  });
});

describe('failures to run at all', () => {
  it('reports a timeout', async () => {
    const { elevator } = setup({ mode: 'auto', responder: () => ({ code: null, timedOut: true }) });
    await expect(elevator.run([EXPORT], 'reason')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a program that could not be started', async () => {
    const { elevator } = setup({ mode: 'none', responder: () => ({ code: null, spawnError: 'ENOENT' }) });
    await expect(elevator.run([EXPORT], 'reason')).rejects.toMatchObject({ kind: 'elevation-failed' });
  });
});
