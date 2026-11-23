import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment } from './cli/exec.js';
import { LittleSnitchError } from './errors.js';

export const LOCKF_PATH = '/usr/bin/lockf';
/**
 * One lock for the whole Mac. Little Snitch has one configuration for all
 * users, so two users who change it at the same moment must share a lock too.
 * /private/var/tmp is writable by every user, and its sticky bit keeps one
 * user from removing another's file.
 */
export const SYSTEM_LOCK_FILE = '/private/var/tmp/little-snitch-mcp-server.lock';
/** lockf exits with this code (EX_TEMPFAIL) when the file is locked by someone else. */
const ALREADY_LOCKED = 75;
const ACQUIRE_TIMEOUT_MS = 15_000;

export interface LockHandle {
  release(): Promise<void>;
  /** False once the process that holds the lock for this server has ended, for whatever reason. */
  isHeld(): boolean;
}
export type AcquireLock = (file: string) => Promise<LockHandle>;

/** For tests: another program in place of lockf, and a shorter wait for it. */
export interface LockOptions {
  readonly lockfPath?: string;
  readonly acquireTimeoutMs?: number;
}

const busy = (message: string): LittleSnitchError => new LittleSnitchError('busy', message);

/**
 * Makes sure the lock file is an ordinary file that every user can open. It is
 * created without following a link, and a link or anything else in its place is
 * refused: in a folder all users can write to, someone else may have put it there.
 */
async function prepareLockFile(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, '', { flag: 'wx', mode: 0o644 });
    // The mode above is cut down by the umask. Other users must be able to open the file to lock it.
    await chmod(file, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw busy(`The lock file ${file} could not be created: ${(error as Error).message}`);
    }
  }
  const facts = await lstat(file);
  if (facts.isSymbolicLink() || !facts.isFile()) {
    throw busy(`${file} is not an ordinary file, so it is not used as a lock. Remove it and try again.`);
  }
}

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
 * If `lockf` itself dies while the lock is wanted, `isHeld` turns false.
 */
export async function acquireKernelLock(file: string, options: LockOptions = {}): Promise<LockHandle> {
  await prepareLockFile(file);
  return new Promise<LockHandle>((resolve, reject) => {
    const child = spawn(options.lockfPath ?? LOCKF_PATH, ['-k', '-t', '0', file, '/bin/sh', '-c', 'echo held; exec /bin/cat >/dev/null'], {
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
    const giveUp = setTimeout(() => {
      if (!held) {
        child.kill('SIGKILL');
        reject(busy('The lock that keeps changes apart could not be taken in time.'));
      }
    }, options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!held && stdout.includes('held')) {
        held = true;
        clearTimeout(giveUp);
        resolve({
          isHeld: () => !closed,
          async release() {
            if (!closed) {
              child.stdin.end();
              const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
              await whenClosed;
              clearTimeout(timer);
            }
          },
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // A broken pipe on release is expected when the holder is already gone.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(giveUp);
      if (!held) {
        reject(busy(`The lock that keeps changes apart could not be taken: ${error.message}`));
      }
    });
    child.on('close', (code) => {
      clearTimeout(giveUp);
      if (held) {
        return;
      }
      reject(
        code === ALREADY_LOCKED
          ? busy('Another change to Little Snitch is in progress on this Mac. Try again when it has finished.')
          : busy(`The lock that keeps changes apart could not be taken (lockf exit ${String(code)}): ${stderr.trim().slice(0, 200)}`),
      );
    });
  });
}
