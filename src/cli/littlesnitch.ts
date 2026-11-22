import type { Config } from '../config.js';
import { LittleSnitchError, TERMINAL_ACCESS_REMEDY } from '../errors.js';
import type { BinaryChecker } from './binary.js';
import { SUDO_PATH, type Elevator, type Method, type Step } from './elevation.js';
import type { ExecFn } from './exec.js';
import type { StepOutput } from './shell.js';

export type TerminalAccess = 'enabled' | 'disabled' | 'unknown';

export interface LittleSnitchCli {
  /** The version string the tool prints, for example "6.5". Needs no privileges. */
  version(): Promise<string>;
  /** Whether "Allow access via Terminal" is on, found without root. */
  terminalAccess(): Promise<TerminalAccess>;
  /** Whether sudo runs the tool right now without asking anyone. */
  sudoWithoutPrompt(): Promise<boolean>;
  exportModel(): Promise<string>;
  logTraffic(begin: string, end?: string): Promise<string>;
  listPreferences(scope: PreferenceScope): Promise<string>;
  /** Little Snitch's own log messages as JSON. Needs no privileges. */
  readLog(minutes: number): Promise<string>;
  /** Each change below also returns the configuration as it is afterwards, read under the same approval. */
  activateProfile(name: string): Promise<ChangeResult>;
  deactivateAllProfiles(): Promise<ChangeResult>;
  setRuleGroupEnabled(name: string, enabled: boolean): Promise<ChangeResult>;
  /** Replaces the whole configuration with the file's. */
  restoreModel(file: string, reason: string): Promise<ChangeResult>;
}

export type PreferenceScope = 'all' | 'global' | 'user';

export interface ChangeResult {
  readonly modelText: string;
  readonly method: Method;
}

export interface CliDeps {
  readonly exec: ExecFn;
  readonly elevator: Elevator;
  readonly binary: BinaryChecker;
  readonly config: Pick<Config, 'cliPath' | 'elevation' | 'commandTimeoutMs'>;
}

const TRAFFIC_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function firstLines(text: string): string {
  return text.trim().split('\n').slice(0, 6).join('\n').slice(0, 600);
}

/** Turns a failed run of the tool into the error a person can act on. */
export function failure(step: StepOutput, what: string): LittleSnitchError {
  const text = `${step.stderr}\n${step.stdout}`;
  if (/not authorized/i.test(text) && /enable access/i.test(text)) {
    return new LittleSnitchError('terminal-access-disabled', 'Little Snitch does not allow its command-line tool to be used yet.', {
      remedy: TERMINAL_ACCESS_REMEDY,
    });
  }
  if (step.code === 14 || /must be run as root/i.test(text)) {
    return new LittleSnitchError('needs-root', 'The Little Snitch tool refused to run without root.', {
      remedy: 'Use elevation "auto", "sudo" or "dialog", or start this server as root when elevation is "none".',
    });
  }
  return new LittleSnitchError('cli-failed', `Little Snitch could not ${what} (exit ${step.code}): ${firstLines(text) || 'no message'}`);
}

/** A name passed to the tool as its own argument. It must never look like an option. */
export function assertSafeName(kind: string, name: string): void {
  if (name.trim() === '' || name.length > 200) {
    throw new LittleSnitchError('invalid-input', `The ${kind} name must be between 1 and 200 characters.`);
  }
  if (name.startsWith('-')) {
    throw new LittleSnitchError('invalid-input', `The ${kind} name must not start with "-".`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new LittleSnitchError('invalid-input', `The ${kind} name must not contain control characters.`);
  }
}

export function createCli(deps: CliDeps): LittleSnitchCli {
  const { exec, elevator, binary, config } = deps;

  const plain = async (args: readonly string[]): Promise<StepOutput> => {
    const check = await binary.inspect(false);
    if (!check.exists) {
      throw new LittleSnitchError('not-installed', check.problems.join(' '), {
        remedy: 'Install Little Snitch 6 from https://obdev.at/littlesnitch.',
      });
    }
    const result = await exec(config.cliPath, args, { timeoutMs: config.commandTimeoutMs });
    if (result.spawnError !== undefined) {
      throw new LittleSnitchError('cli-failed', `Could not start the Little Snitch tool: ${result.spawnError}`);
    }
    if (result.timedOut) {
      throw new LittleSnitchError('timeout', 'The Little Snitch tool did not answer in time.');
    }
    return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
  };

  const elevated = async (steps: readonly Step[], reason: string): Promise<{ outputs: readonly StepOutput[]; method: Method }> => {
    if (config.elevation !== 'none') {
      await binary.assertTrusted();
    }
    const run = await elevator.run(steps, reason);
    return { outputs: run.steps, method: run.method };
  };

  const one = async (step: Step, what: string, reason: string): Promise<{ stdout: string; method: Method }> => {
    const { outputs, method } = await elevated([step], reason);
    const output = outputs[0];
    if (output === undefined) {
      throw new LittleSnitchError('unexpected-output', `Little Snitch gave no result when asked to ${what}.`);
    }
    if (output.code !== 0) {
      throw failure(output, what);
    }
    return { stdout: output.stdout, method };
  };

  /** Runs one change and then reads the configuration back, under a single approval where the method allows it. */
  const writeThenExport = async (args: readonly string[], what: string, reason: string): Promise<ChangeResult> => {
    const { outputs, method } = await elevated([{ args, write: true }, { args: ['export-model'] }], reason);
    const changed = outputs[0];
    if (changed === undefined) {
      throw new LittleSnitchError('unexpected-output', `Little Snitch gave no result when asked to ${what}.`);
    }
    if (changed.code !== 0) {
      throw failure(changed, what);
    }
    const exported = outputs[1];
    if (exported === undefined || exported.code !== 0) {
      throw new LittleSnitchError(
        'verification-failed',
        `Little Snitch accepted the request to ${what}, but its configuration could not be read back to check it.`,
        { details: { changed: true, readBack: exported === undefined ? 'did not run' : firstLines(`${exported.stderr}\n${exported.stdout}`) } },
      );
    }
    return { modelText: exported.stdout, method };
  };

  return {
    async version() {
      const output = await plain(['--version']);
      const match = /(\d+(?:\.\d+)+)/.exec(output.stdout);
      if (output.code !== 0 || match === null || match[1] === undefined) {
        throw new LittleSnitchError('unexpected-output', `Could not read the Little Snitch version from "${firstLines(output.stdout)}".`);
      }
      return match[1];
    },

    async terminalAccess() {
      const output = await plain(['restrictions']);
      if (/not authorized/i.test(`${output.stderr}\n${output.stdout}`)) {
        return 'disabled';
      }
      return output.code === 0 ? 'enabled' : 'unknown';
    },

    async sudoWithoutPrompt() {
      const result = await exec(SUDO_PATH, ['-n', '--', config.cliPath, '--version'], { timeoutMs: 15_000, detached: true });
      return result.code === 0;
    },

    async exportModel() {
      const { stdout } = await one({ args: ['export-model'] }, 'export its configuration', 'Little Snitch MCP wants to read your Little Snitch rules and settings.');
      return stdout;
    },

    async logTraffic(begin, end) {
      for (const value of end === undefined ? [begin] : [begin, end]) {
        if (!TRAFFIC_DATE.test(value)) {
          throw new LittleSnitchError('invalid-input', `"${value}" is not a date in the form YYYY-MM-DD HH:MM:SS.`);
        }
      }
      const args = ['log-traffic', '--begin-date', begin, ...(end === undefined ? [] : ['--end-date', end])];
      const { stdout } = await one({ args }, 'read the traffic log', 'Little Snitch MCP wants to read your Little Snitch traffic history.');
      return stdout;
    },

    async listPreferences(scope) {
      const flag = scope === 'global' ? ['--global-only'] : scope === 'user' ? ['--user-only'] : [];
      const { stdout } = await one({ args: ['list-preferences', ...flag] }, 'list its preferences', 'Little Snitch MCP wants to read your Little Snitch preferences.');
      return stdout;
    },

    async readLog(minutes) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
        throw new LittleSnitchError('invalid-input', 'The log window must be between 1 minute and 7 days.');
      }
      const output = await plain(['log', '--last', `${minutes}m`, '--json']);
      if (output.code !== 0) {
        throw failure(output, 'read its log');
      }
      return output.stdout;
    },

    async activateProfile(name) {
      assertSafeName('profile', name);
      return writeThenExport(
        ['profile', '--activate', name],
        `activate the profile "${name}"`,
        `Little Snitch MCP wants to activate the Little Snitch profile "${name}".`,
      );
    },

    async deactivateAllProfiles() {
      return writeThenExport(['profile', '--deactivate-all'], 'deactivate all profiles', 'Little Snitch MCP wants to deactivate all Little Snitch profiles.');
    },

    async setRuleGroupEnabled(name, enabled) {
      assertSafeName('rule group', name);
      const verb = enabled ? 'enable' : 'disable';
      return writeThenExport(
        ['rulegroup', `--${verb}`, name],
        `${verb} the rule group "${name}"`,
        `Little Snitch MCP wants to ${verb} the Little Snitch rule group or blocklist "${name}".`,
      );
    },

    async restoreModel(file, reason) {
      return writeThenExport(['restore-model', '--preserve-terminal-access', file], 'apply the change', reason);
    },
  };
}
