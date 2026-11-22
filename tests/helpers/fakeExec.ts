import type { ExecFn, ExecOptions, ExecResult } from '../../src/cli/exec.js';

export interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

export type Responder = (call: RecordedCall) => Partial<ExecResult> | undefined;

export function result(partial: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, overflow: false, ...partial };
}

/** An exec that records every call and answers from the responder. A call nobody answers fails the test. */
export function fakeExec(responder: Responder): { exec: ExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const answer = responder(call);
    if (answer === undefined) {
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    }
    return result(answer);
  };
  return { exec, calls };
}

export const SUDO_NEEDS_PASSWORD: Partial<ExecResult> = { code: 1, stderr: 'sudo: a password is required\n' };
export const SUDO_NO_TERMINAL: Partial<ExecResult> = {
  code: 1,
  stderr: 'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n',
};
