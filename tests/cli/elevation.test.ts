import { describe, expect, it } from 'vitest';
import { classifySudo, createElevator, OSASCRIPT_PATH, SUDO_PATH, touchIdConfigured, type ElevationDeps } from '../../src/cli/elevation.js';
import type { ElevationMode } from '../../src/config.js';
import { LittleSnitchError } from '../../src/errors.js';
import { fakeExec, result, SUDO_NEEDS_PASSWORD, SUDO_NO_TERMINAL, type Responder } from '../helpers/fakeExec.js';

const CLI = '/Applications/Little Snitch.app/Contents/Components/littlesnitch';
const TOKEN = 'abcdefghijklmnop0123';

function setup(options: { mode: ElevationMode; touchId?: boolean; unattended?: boolean; responder: Responder }) {
  const { exec, calls } = fakeExec(options.responder);
  const deps: ElevationDeps = {
    exec,
    config: { cliPath: CLI, elevation: options.mode, unattendedWrites: options.unattended ?? false, interactiveTimeoutMs: 300_000, commandTimeoutMs: 60_000 },
    touchIdConfigured: async () => options.touchId ?? false,
    randomToken: () => TOKEN,
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

describe('elevation "none"', () => {
  it('runs the tool directly and stops at the first failure', async () => {
    const { elevator, calls } = setup({
      mode: 'none',
      responder: ({ args }) => (args[0] === 'restore-model' ? { code: 1, stderr: 'bad file' } : { stdout: '{}' }),
    });
    const run = await elevator.run([{ args: ['restore-model', '/tmp/x'], write: true }, { args: ['export-model'] }], 'reason');
    expect(run.method).toBe('direct');
    expect(run.steps).toEqual([{ code: 1, stdout: '', stderr: 'bad file' }]);
    expect(calls.map((call) => call.file)).toEqual([CLI]);
  });
});

describe('elevation "auto"', () => {
  it('uses sudo without a prompt for a read when sudo allows it', async () => {
    const { elevator, calls } = setup({ mode: 'auto', responder: () => ({ stdout: '{"rules":[]}' }) });
    const run = await elevator.run([{ args: ['export-model'] }], 'reason');
    expect(run).toEqual({ method: 'sudo', steps: [{ code: 0, stdout: '{"rules":[]}', stderr: '' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(SUDO_PATH);
    expect(calls[0]?.args).toEqual(['-n', '--', CLI, 'export-model']);
    expect(calls[0]?.options.detached).toBe(true);
  });

  it('falls back to the administrator dialog for a read when sudo needs a password and Touch ID is not set up', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NEEDS_PASSWORD : { stdout: dialogOutput([{ code: 0, stdout: '{"rules":[]}' }]) }),
    });
    const run = await elevator.run([{ args: ['export-model'] }], 'Please allow reading');
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

  it('never tries sudo without a prompt for a change: it goes straight to an approval', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === OSASCRIPT_PATH ? { stdout: dialogOutput([{ code: 0, stdout: '' }, { code: 0, stdout: '{}' }]) } : undefined),
    });
    const run = await elevator.run([{ args: ['restore-model', '/tmp/x'], write: true }, { args: ['export-model'] }], 'Approve the change');
    expect(run.method).toBe('dialog');
    expect(run.steps).toHaveLength(2);
    expect(calls.map((call) => call.file)).toEqual([OSASCRIPT_PATH]);
  });

  it('forces a fresh Touch ID for a change with sudo -k, then reads back without a new approval', async () => {
    const { elevator, calls } = setup({ mode: 'auto', touchId: true, responder: () => ({ stdout: 'ok' }) });
    await elevator.run([{ args: ['restore-model', '/tmp/x'], write: true }, { args: ['export-model'] }], 'reason');
    expect(calls.map((call) => call.args)).toEqual([
      ['-k', '--', CLI, 'restore-model', '/tmp/x'],
      ['-n', '--', CLI, 'export-model'],
    ]);
  });

  it('runs a change through sudo without a prompt only when unattended writes are switched on', async () => {
    const { elevator, calls } = setup({ mode: 'auto', unattended: true, responder: () => ({ stdout: 'ok' }) });
    const run = await elevator.run([{ args: ['profile', '--activate', 'Work'], write: true }], 'reason');
    expect(run.method).toBe('sudo');
    expect(calls[0]?.args).toEqual(['-n', '--', CLI, 'profile', '--activate', 'Work']);
  });

  it('falls back to the administrator dialog when Touch ID through sudo does not work', async () => {
    const { elevator, calls } = setup({
      mode: 'auto',
      touchId: true,
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NO_TERMINAL : { stdout: dialogOutput([{ code: 0, stdout: '{}' }]) }),
    });
    const run = await elevator.run([{ args: ['export-model'] }], 'reason');
    expect(run.method).toBe('dialog');
    expect(calls.map((call) => call.file)).toEqual([SUDO_PATH, SUDO_PATH, OSASCRIPT_PATH]);
  });

  it('reports a cancelled Touch ID as cancelled when the dialog is not allowed', async () => {
    const { elevator } = setup({ mode: 'sudo', touchId: true, responder: () => SUDO_NO_TERMINAL });
    await expect(elevator.run([{ args: ['export-model'] }], 'reason')).rejects.toMatchObject({ kind: 'elevation-cancelled' });
  });

  it('reports a cancelled administrator dialog as cancelled', async () => {
    const { elevator } = setup({
      mode: 'auto',
      responder: ({ file }) => (file === SUDO_PATH ? SUDO_NEEDS_PASSWORD : { code: 1, stderr: 'execution error: User canceled. (-128)\n' }),
    });
    await expect(elevator.run([{ args: ['export-model'] }], 'reason')).rejects.toMatchObject({ kind: 'elevation-cancelled' });
  });

  it('reports an account that may not use sudo', async () => {
    const { elevator } = setup({ mode: 'auto', responder: () => ({ code: 1, stderr: 'sudo: guest is not in the sudoers file.\n' }) });
    await expect(elevator.run([{ args: ['export-model'] }], 'reason')).rejects.toMatchObject({ kind: 'elevation-unavailable' });
  });

  it('passes the tool\'s own failure back instead of treating it as a sudo problem', async () => {
    const { elevator } = setup({ mode: 'auto', responder: () => ({ code: 14, stderr: 'littlesnitch must be run as root!\n' }) });
    const run = await elevator.run([{ args: ['export-model'] }], 'reason');
    expect(run.steps).toEqual([{ code: 14, stdout: '', stderr: 'littlesnitch must be run as root!\n' }]);
  });
});

describe('elevation "sudo"', () => {
  it('never opens the administrator dialog', async () => {
    const { elevator, calls } = setup({ mode: 'sudo', responder: () => SUDO_NEEDS_PASSWORD });
    const error = await elevator.run([{ args: ['export-model'] }], 'reason').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LittleSnitchError);
    expect((error as LittleSnitchError).kind).toBe('elevation-unavailable');
    expect(calls.every((call) => call.file === SUDO_PATH)).toBe(true);
  });

  it('refuses a change that cannot be approved when Touch ID is not set up', async () => {
    const { elevator, calls } = setup({ mode: 'sudo', responder: () => ({ stdout: 'ok' }) });
    await expect(elevator.run([{ args: ['profile', '--deactivate-all'], write: true }], 'reason')).rejects.toMatchObject({
      kind: 'elevation-unavailable',
    });
    expect(calls).toHaveLength(0);
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
    await expect(elevator.run([{ args: ['export-model'] }], 'reason')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a program that could not be started', async () => {
    const { elevator } = setup({ mode: 'none', responder: () => ({ code: null, spawnError: 'ENOENT' }) });
    await expect(elevator.run([{ args: ['export-model'] }], 'reason')).rejects.toMatchObject({ kind: 'elevation-failed' });
  });
});
