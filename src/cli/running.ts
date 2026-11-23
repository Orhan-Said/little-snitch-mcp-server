import { LittleSnitchError } from '../errors.js';
import type { ExecFn } from './exec.js';

export const PS_PATH = '/bin/ps';

/** The commands of the Little Snitch tool that change the configuration. */
const CHANGING_COMMANDS = ['restore-model', 'profile', 'rulegroup'] as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A command line as the process list shows it and the same line inside a quoted shell script, made comparable. */
const unquoted = (text: string): string => text.replace(/['"\\]/g, '');

/**
 * True when one line of the process list shows the Little Snitch tool being
 * run with a command that changes the configuration. The line may be the tool
 * itself, or the shell, sudo or osascript that carries the command in its
 * arguments. A read (export-model, log-traffic and so on) does not count.
 */
export function showsChangingCommand(line: string, cliPath: string): boolean {
  const pattern = new RegExp(`${escapeRegExp(unquoted(cliPath))}\\s+(?:(?:-u|--user)\\s+\\S+\\s+)?(?:${CHANGING_COMMANDS.join('|')})(?:\\s|$)`);
  return pattern.test(unquoted(line));
}

/**
 * Looks at the programs running on this Mac, of every user, for a command that
 * changes Little Snitch. `ps` belongs to macOS and shows the arguments of
 * root's processes too.
 *
 * This is how the server learns that a command it gave up on (after a timeout)
 * or a command of a server that has gone is still at work. When the list
 * cannot be read, the answer is an error, not "nothing is running".
 */
export async function changingCommandRunning(exec: ExecFn, cliPath: string): Promise<boolean> {
  const result = await exec(PS_PATH, ['-axww', '-o', 'command='], { timeoutMs: 10_000, maxBytes: 32 * 1024 * 1024 });
  if (result.spawnError !== undefined || result.timedOut || result.overflow || result.code !== 0) {
    throw new LittleSnitchError(
      'busy',
      'The list of running programs could not be read, so this server cannot tell whether another change to Little Snitch is still in progress. Nothing was changed.',
    );
  }
  return result.stdout.split('\n').some((line) => showsChangingCommand(line, cliPath));
}
