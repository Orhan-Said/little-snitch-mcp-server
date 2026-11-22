import { describe, expect, it } from 'vitest';
import type { BinaryChecker } from '../../src/cli/binary.js';
import type { Elevator, Step } from '../../src/cli/elevation.js';
import { assertSafeName, createCli, failure } from '../../src/cli/littlesnitch.js';
import type { StepOutput } from '../../src/cli/shell.js';
import type { ElevationMode } from '../../src/config.js';
import { fakeExec, type Responder } from '../helpers/fakeExec.js';

const CLI = '/fake/littlesnitch';

function setup(options: {
  outputs?: readonly StepOutput[];
  responder?: Responder;
  mode?: ElevationMode;
  trusted?: boolean;
  exists?: boolean;
}) {
  const runs: Array<{ steps: readonly Step[]; reason: string }> = [];
  const elevator: Elevator = {
    run: async (steps, reason) => {
      runs.push({ steps, reason });
      return { method: 'sudo', steps: options.outputs ?? [] };
    },
  };
  let trustChecks = 0;
  const binary: BinaryChecker = {
    inspect: async () => ({
      exists: options.exists ?? true,
      ownedByRoot: true,
      writableByOthers: false,
      signedByObjectiveDevelopment: null,
      problems: options.exists === false ? ['not found'] : [],
    }),
    assertTrusted: async () => {
      trustChecks += 1;
      if (options.trusted === false) {
        throw new Error('untrusted');
      }
    },
  };
  const { exec, calls } = fakeExec(options.responder ?? (() => undefined));
  const cli = createCli({ exec, elevator, binary, config: { cliPath: CLI, elevation: options.mode ?? 'auto', commandTimeoutMs: 1000 } });
  return { cli, runs, calls, trustChecks: () => trustChecks };
}

const ok = (stdout: string): StepOutput => ({ code: 0, stdout, stderr: '' });

describe('failure', () => {
  it('recognises that terminal access is switched off', () => {
    const error = failure(
      { code: 1, stdout: '', stderr: 'Error: command line tool is not authorized to make changes.\nPlease enable access in Little Snitch.app > Preferences > Security.\n' },
      'export its configuration',
    );
    expect(error.kind).toBe('terminal-access-disabled');
    expect(error.remedy).toContain('Allow access via Terminal');
  });

  it('recognises a missing root', () => {
    expect(failure({ code: 14, stdout: 'littlesnitch must be run as root!\n', stderr: '' }, 'x').kind).toBe('needs-root');
  });

  it('reports anything else with the tool\'s own words', () => {
    const error = failure({ code: 1, stdout: '', stderr: 'Rule group or blocklist "Nope" not found.\n' }, 'enable the rule group "Nope"');
    expect(error.kind).toBe('cli-failed');
    expect(error.message).toBe('Little Snitch could not enable the rule group "Nope" (exit 1): Rule group or blocklist "Nope" not found.');
  });
});

describe('assertSafeName', () => {
  it('accepts an ordinary name', () => {
    expect(() => assertSafeName('profile', 'Home Office')).not.toThrow();
  });

  it('refuses a name that could be read as an option, is empty, or holds control characters', () => {
    expect(() => assertSafeName('profile', '--deactivate-all')).toThrow(/must not start with "-"/);
    expect(() => assertSafeName('profile', '   ')).toThrow(/between 1 and 200/);
    expect(() => assertSafeName('profile', 'a\nb')).toThrow(/control characters/);
  });
});

describe('createCli', () => {
  it('reads the version without privileges', async () => {
    const { cli, calls, runs } = setup({ responder: () => ({ stdout: 'Version 6.5\n' }) });
    expect(await cli.version()).toBe('6.5');
    expect(calls[0]).toMatchObject({ file: CLI, args: ['--version'] });
    expect(runs).toHaveLength(0);
  });

  it('reports the tool as not installed when the file is missing', async () => {
    const { cli } = setup({ exists: false });
    await expect(cli.version()).rejects.toMatchObject({ kind: 'not-installed' });
  });

  it('reads the terminal access setting from the restrictions command', async () => {
    const disabled = setup({ responder: () => ({ code: 1, stdout: 'Error: command line tool is not authorized to make changes.\n' }) });
    expect(await disabled.cli.terminalAccess()).toBe('disabled');
    const enabled = setup({ responder: () => ({ code: 0, stdout: 'No restrictions.\n' }) });
    expect(await enabled.cli.terminalAccess()).toBe('enabled');
    const unknown = setup({ responder: () => ({ code: 14, stdout: 'littlesnitch must be run as root!\n' }) });
    expect(await unknown.cli.terminalAccess()).toBe('unknown');
  });

  it('exports the model as a read and checks the binary first', async () => {
    const { cli, runs, trustChecks } = setup({ outputs: [ok('{"rules":[]}')] });
    expect(await cli.exportModel()).toBe('{"rules":[]}');
    expect(runs[0]?.steps).toEqual([{ args: ['export-model'] }]);
    expect(trustChecks()).toBe(1);
  });

  it('does not run anything as root when the binary is not trusted', async () => {
    const { cli, runs } = setup({ outputs: [ok('{}')], trusted: false });
    await expect(cli.exportModel()).rejects.toThrow('untrusted');
    expect(runs).toHaveLength(0);
  });

  it('skips the binary check when elevation is "none"', async () => {
    const { cli, trustChecks } = setup({ outputs: [ok('{}')], mode: 'none' });
    await cli.exportModel();
    expect(trustChecks()).toBe(0);
  });

  it('turns a refused export into the terminal access error', async () => {
    const { cli } = setup({
      outputs: [{ code: 1, stdout: '', stderr: 'Error: command line tool is not authorized to make changes.\nPlease enable access in Little Snitch.app > Preferences > Security.\n' }],
    });
    await expect(cli.exportModel()).rejects.toMatchObject({ kind: 'terminal-access-disabled' });
  });

  it('builds the traffic command from validated dates', async () => {
    const { cli, runs } = setup({ outputs: [ok('date,direction\n')] });
    await cli.logTraffic('2026-11-22 10:00:00', '2026-11-22 11:00:00');
    expect(runs[0]?.steps[0]?.args).toEqual(['log-traffic', '--begin-date', '2026-11-22 10:00:00', '--end-date', '2026-11-22 11:00:00']);
    await expect(cli.logTraffic('yesterday')).rejects.toMatchObject({ kind: 'invalid-input' });
    await expect(cli.logTraffic('2026-11-22 10:00:00', '--stream')).rejects.toMatchObject({ kind: 'invalid-input' });
  });

  it('runs profile and rule group commands as changes followed by a read-back', async () => {
    const { cli, runs } = setup({ outputs: [ok(''), ok('{"rules":[]}')] });
    expect(await cli.activateProfile('Work')).toEqual({ modelText: '{"rules":[]}', method: 'sudo' });
    await cli.deactivateAllProfiles();
    await cli.setRuleGroupEnabled('macOS Services', false);
    await cli.setRuleGroupEnabled('macOS Services', true);
    const readBack = { args: ['export-model'] };
    expect(runs.map((run) => run.steps)).toEqual([
      [{ args: ['profile', '--activate', 'Work'], write: true }, readBack],
      [{ args: ['profile', '--deactivate-all'], write: true }, readBack],
      [{ args: ['rulegroup', '--disable', 'macOS Services'], write: true }, readBack],
      [{ args: ['rulegroup', '--enable', 'macOS Services'], write: true }, readBack],
    ]);
    expect(runs[0]?.reason).toBe('Little Snitch MCP wants to activate the Little Snitch profile "Work".');
  });

  it('refuses a profile name that looks like an option before running anything', async () => {
    const { cli, runs } = setup({ outputs: [ok('')] });
    await expect(cli.activateProfile('-d')).rejects.toMatchObject({ kind: 'invalid-input' });
    expect(runs).toHaveLength(0);
  });

  it('reports a rule group Little Snitch does not know', async () => {
    const { cli } = setup({ outputs: [{ code: 1, stdout: '', stderr: 'Rule group or blocklist "Nope" not found.\n' }] });
    await expect(cli.setRuleGroupEnabled('Nope', true)).rejects.toMatchObject({ kind: 'cli-failed' });
  });

  it('restores with terminal access preserved and returns the configuration read back', async () => {
    const { cli, runs } = setup({ outputs: [ok(''), ok('{"rules":[1]}')] });
    const restored = await cli.restoreModel('/data/pending/x.json', 'Approve');
    expect(restored).toEqual({ modelText: '{"rules":[1]}', method: 'sudo' });
    expect(runs[0]?.steps).toEqual([
      { args: ['restore-model', '--preserve-terminal-access', '/data/pending/x.json'], write: true },
      { args: ['export-model'] },
    ]);
  });

  it('reports a change whose result could not be read back', async () => {
    const { cli } = setup({ outputs: [ok('')] });
    await expect(cli.restoreModel('/data/pending/x.json', 'Approve')).rejects.toMatchObject({
      kind: 'verification-failed',
      details: { changed: true },
    });
  });

  it('reports a restore Little Snitch refused', async () => {
    const { cli } = setup({ outputs: [{ code: 1, stdout: '', stderr: 'Invalid backup file\n' }] });
    await expect(cli.restoreModel('/data/pending/x.json', 'Approve')).rejects.toMatchObject({ kind: 'cli-failed' });
  });

  it('limits a preference listing to one scope when asked', async () => {
    const { cli, runs } = setup({ outputs: [ok('a = 1\n')] });
    await cli.listPreferences('global');
    await cli.listPreferences('user');
    await cli.listPreferences('all');
    expect(runs.map((run) => run.steps[0]?.args)).toEqual([['list-preferences', '--global-only'], ['list-preferences', '--user-only'], ['list-preferences']]);
  });

  it('reads the log without privileges and limits the window', async () => {
    const { cli, calls, runs } = setup({ responder: () => ({ stdout: '[]' }) });
    expect(await cli.readLog(30)).toBe('[]');
    expect(calls[0]?.args).toEqual(['log', '--last', '30m', '--json']);
    expect(runs).toHaveLength(0);
    await expect(cli.readLog(0)).rejects.toMatchObject({ kind: 'invalid-input' });
  });

  it('probes sudo with a harmless command', async () => {
    const { cli, calls } = setup({ responder: () => ({ code: 1, stderr: 'sudo: a password is required\n' }) });
    expect(await cli.sudoWithoutPrompt()).toBe(false);
    expect(calls[0]?.args).toEqual(['-n', '--', CLI, '--version']);
  });
});
