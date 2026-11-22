import { spawn } from 'node:child_process';

export interface ExecOptions {
  readonly timeoutMs: number;
  /** Stop reading after this many bytes of stdout. */
  readonly maxBytes?: number;
  /** Start the child in its own session, so it can never read a password from the terminal the server runs in. */
  readonly detached?: boolean;
}

export interface ExecResult {
  /** Exit code, or null when the child was killed or never started. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly overflow: boolean;
  /** Set when the program could not be started at all. */
  readonly spawnError?: string;
}

export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The environment handed to every child: a fixed PATH and locale, so that
 * nothing from the MCP client's environment reaches a command run as root and
 * error messages come back in English.
 */
export function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['HOME', 'USER', 'LOGNAME', 'TMPDIR'] as const;
  const kept = Object.fromEntries(keep.flatMap((key) => (parent[key] === undefined ? [] : [[key, parent[key]]])));
  return { ...kept, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
}

export const execFile: ExecFn = (file, args, options) =>
  new Promise<ExecResult>((resolve) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const child = spawn(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached === true,
      env: childEnvironment(process.env),
    });

    const kill = (): void => {
      try {
        if (options.detached === true && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // The child is already gone, or it runs as root and is not ours to stop.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        overflow,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        overflow = true;
        kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) {
        stderr.push(chunk);
      }
    });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
