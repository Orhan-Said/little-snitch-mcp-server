import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment } from './cli/exec.js';
import { LittleSnitchError } from './errors.js';

export const LOCKF_PATH = '/usr/bin/lockf';
/** lockf exits with this code (EX_TEMPFAIL) when the file is locked by someone else. */
const ALREADY_LOCKED = 75;

export type ReleaseLock = () => Promise<void>;
export type AcquireLock = (file: string) => Promise<ReleaseLock>;

/**
 * Takes an exclusive lock that the kernel holds, through macOS's `lockf`.
 *
 * `lockf` locks the file and then runs a command for as long as the lock is
 * wanted. Here the command is `cat`, reading from a pipe this process keeps
 * open. Closing the pipe ends `cat`, which ends `lockf`, which frees the lock.
 * If this server dies, the pipe closes with it, so a lock can never be left
 * behind and nothing ever has to decide whether a lock is stale.
 *
 * A second taker is refused at once (it does not wait) with the error "busy".
 */
export const acquireKernelLock: AcquireLock = async (file) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return new Promise<ReleaseLock>((resolve, reject) => {
    const child = spawn(LOCKF_PATH, ['-k', '-t', '0', file, '/bin/sh', '-c', 'echo held; exec /bin/cat >/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment(process.env),
    });
    let stdout = '';
    let stderr = '';
    let held = false;
    let closed = false;
    const whenClosed = new Promise<void>((done) => {
      child.on('close', () => {
        closed = true;
        done();
      });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!held && stdout.includes('held')) {
        held = true;
        resolve(async () => {
          if (!closed) {
            child.stdin.end();
            const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
            await whenClosed;
            clearTimeout(timer);
          }
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // A broken pipe on release is expected when the holder is already gone.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      if (!held) {
        reject(new LittleSnitchError('busy', `The lock that keeps changes apart could not be taken: ${error.message}`));
      }
    });
    child.on('close', (code) => {
      if (held) {
        return;
      }
      reject(
        code === ALREADY_LOCKED
          ? new LittleSnitchError('busy', 'Another change to Little Snitch is in progress. Try again when it has finished.')
          : new LittleSnitchError('busy', `The lock that keeps changes apart could not be taken (lockf exit ${String(code)}): ${stderr.trim().slice(0, 200)}`),
      );
    });
  });
};
