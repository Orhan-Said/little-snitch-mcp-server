import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import { ELEVATION_REMEDY, LittleSnitchError } from '../errors.js';
import type { ExecFn, ExecResult } from './exec.js';
import { adminDialogArgs, buildCompoundScript, parseCompoundOutput, type StepOutput } from './shell.js';

export const SUDO_PATH = '/usr/bin/sudo';
export const OSASCRIPT_PATH = '/usr/bin/osascript';

/** One run of the littlesnitch tool as root. `write` marks a command that changes the firewall. */
export interface Step {
  readonly args: readonly string[];
  readonly write?: boolean;
}

export type Method = 'direct' | 'sudo' | 'sudo-interactive' | 'dialog';

export interface ElevatedRun {
  /** How the last command that ran got its privileges. */
  readonly method: Method;
  /** One entry per command that ran; a command that failed is the last entry. */
  readonly steps: readonly StepOutput[];
}

export interface Elevator {
  run(steps: readonly Step[], reason: string): Promise<ElevatedRun>;
}

export interface ElevationDeps {
  readonly exec: ExecFn;
  readonly config: Pick<Config, 'cliPath' | 'elevation' | 'unattendedWrites' | 'interactiveTimeoutMs' | 'commandTimeoutMs'>;
  /** True when sudo accepts Touch ID (pam_tid), so it can ask without a terminal. */
  readonly touchIdConfigured: () => Promise<boolean>;
  readonly randomToken: () => string;
}

type SudoOutcome =
  | { readonly kind: 'ran'; readonly output: StepOutput }
  | { readonly kind: 'needs-auth'; readonly stderr: string }
  | { readonly kind: 'not-permitted'; readonly stderr: string }
  | { readonly kind: 'failed'; readonly stderr: string };

const PAM_FILES = ['/etc/pam.d/sudo_local', '/etc/pam.d/sudo'] as const;

export async function touchIdConfigured(read: (file: string) => Promise<string> = (file) => readFile(file, 'utf8')): Promise<boolean> {
  for (const file of PAM_FILES) {
    try {
      const text = await read(file);
      if (/^[ \t]*auth[ \t]+\S+[ \t]+pam_tid\.so/m.test(text)) {
        return true;
      }
    } catch {
      // A missing file means it is not configured there.
    }
  }
  return false;
}

function checkStarted(result: ExecResult, program: string): void {
  if (result.spawnError !== undefined) {
    throw new LittleSnitchError('elevation-failed', `Could not start ${program}: ${result.spawnError}`);
  }
  if (result.timedOut) {
    throw new LittleSnitchError('timeout', `${program} did not finish in time. If an approval prompt was open, it was not answered.`);
  }
  if (result.overflow) {
    throw new LittleSnitchError('unexpected-output', 'The command produced more output than this server accepts.');
  }
}

export function classifySudo(result: ExecResult): SudoOutcome {
  const sudoLines = result.stderr.split('\n').filter((line) => line.startsWith('sudo: '));
  if (result.code !== 0 && sudoLines.length > 0) {
    const text = sudoLines.join('\n');
    if (/a password is required|a terminal is required|no askpass program|unable to read password|incorrect password/i.test(text)) {
      return { kind: 'needs-auth', stderr: text };
    }
    if (/not in the sudoers file|is not allowed to (run|execute)|may not run sudo/i.test(text)) {
      return { kind: 'not-permitted', stderr: text };
    }
    return { kind: 'failed', stderr: text };
  }
  return { kind: 'ran', output: { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr } };
}

export function createElevator(deps: ElevationDeps): Elevator {
  const { exec, config } = deps;

  const direct = async (step: Step): Promise<StepOutput> => {
    const result = await exec(config.cliPath, step.args, { timeoutMs: config.commandTimeoutMs });
    checkStarted(result, 'littlesnitch');
    return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
  };

  const sudo = async (step: Step, flags: readonly string[], interactive: boolean): Promise<SudoOutcome> => {
    const result = await exec(SUDO_PATH, [...flags, '--', config.cliPath, ...step.args], {
      timeoutMs: interactive ? config.interactiveTimeoutMs : config.commandTimeoutMs,
      detached: true,
    });
    checkStarted(result, 'sudo');
    return classifySudo(result);
  };

  const dialog = async (steps: readonly Step[], reason: string): Promise<readonly StepOutput[]> => {
    const token = deps.randomToken();
    const script = buildCompoundScript(config.cliPath, steps.map((step) => step.args), token);
    const result = await exec(OSASCRIPT_PATH, adminDialogArgs(script, reason), { timeoutMs: config.interactiveTimeoutMs });
    checkStarted(result, 'the administrator dialog');
    if (result.code !== 0) {
      if (/\(-128\)|user cancell?ed/i.test(result.stderr)) {
        throw new LittleSnitchError('elevation-cancelled', 'The administrator dialog was cancelled, so nothing was run.');
      }
      throw new LittleSnitchError('elevation-failed', `The administrator dialog failed: ${result.stderr.trim().slice(0, 500)}`);
    }
    const outputs = parseCompoundOutput(result.stdout, token);
    if (outputs.length === 0) {
      throw new LittleSnitchError('unexpected-output', 'The command ran but its output could not be read back.');
    }
    return outputs;
  };

  const run = async (steps: readonly Step[], reason: string): Promise<ElevatedRun> => {
    if (steps.length === 0) {
      throw new Error('At least one command is needed.');
    }
    const outputs: StepOutput[] = [];
    let method: Method = 'direct';

    if (config.elevation === 'none') {
      for (const step of steps) {
        const output = await direct(step);
        outputs.push(output);
        if (output.code !== 0) {
          break;
        }
      }
      return { method, steps: outputs };
    }

    if (config.elevation === 'dialog') {
      return { method: 'dialog', steps: await dialog(steps, reason) };
    }

    for (const [index, step] of steps.entries()) {
      const mustApprove = step.write === true && !config.unattendedWrites;
      let outcome: SudoOutcome | undefined;

      if (!mustApprove) {
        outcome = await sudo(step, ['-n'], false);
        method = 'sudo';
      }

      if (outcome === undefined || outcome.kind === 'needs-auth') {
        if (await deps.touchIdConfigured()) {
          // -k makes sudo ignore a cached approval, so each change gets its own Touch ID.
          outcome = await sudo(step, mustApprove ? ['-k'] : [], true);
          method = 'sudo-interactive';
          if (outcome.kind === 'needs-auth' && config.elevation === 'auto') {
            // Touch ID did not work, for example with the lid closed. The password dialog still can.
            const rest = await dialog(steps.slice(index), reason);
            return { method: 'dialog', steps: [...outputs, ...rest] };
          }
          if (outcome.kind === 'needs-auth') {
            throw new LittleSnitchError('elevation-cancelled', 'Touch ID was cancelled or not available, so nothing was run.', {
              remedy: ELEVATION_REMEDY,
            });
          }
        } else if (config.elevation === 'auto') {
          const rest = await dialog(steps.slice(index), reason);
          return { method: 'dialog', steps: [...outputs, ...rest] };
        } else {
          throw new LittleSnitchError(
            'elevation-unavailable',
            mustApprove
              ? 'A change needs your approval, and with elevation "sudo" that takes Touch ID for sudo, which is not set up.'
              : 'sudo asked for a password, and this server cannot type one.',
            { remedy: ELEVATION_REMEDY },
          );
        }
      }

      if (outcome.kind === 'not-permitted') {
        throw new LittleSnitchError('elevation-unavailable', `sudo refused: ${outcome.stderr}`, {
          remedy: 'This macOS account may not use sudo. Use an administrator account, or elevation "dialog" to enter an administrator\'s name and password.',
        });
      }
      if (outcome.kind === 'failed') {
        throw new LittleSnitchError('elevation-failed', `sudo failed: ${outcome.stderr}`);
      }
      outputs.push(outcome.output);
      if (outcome.output.code !== 0) {
        break;
      }
    }
    return { method, steps: outputs };
  };

  return { run };
}
