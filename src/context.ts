import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { createBinaryChecker, type BinaryChecker } from './cli/binary.js';
import { createElevator, touchIdConfigured } from './cli/elevation.js';
import { execFile, type ExecFn } from './cli/exec.js';
import { createCli, type LittleSnitchCli } from './cli/littlesnitch.js';
import { changingCommandRunning } from './cli/running.js';
import { LittleSnitchError } from './errors.js';
import { parseModelText, type JsonObject } from './model/json.js';
import { acquireKernelLock, type AcquireLock, type LockHandle } from './lock.js';
import { createStore, type Store } from './store.js';

export interface ModelCache {
  /** The configuration, read again unless a copy at most `maxAgeMs` old is at hand. */
  get(maxAgeMs: number): Promise<JsonObject>;
  /** Always reads the configuration again. Returns the text as well, for backups. */
  fresh(): Promise<{ readonly model: JsonObject; readonly text: string }>;
  /** Stores the configuration as read back after a change. */
  put(model: JsonObject): void;
  /** The copy at hand, however old, without reading anything. */
  peek(): JsonObject | undefined;
  clear(): void;
}

export interface ChangeQueue {
  /** Runs one change at a time: after every change this server already started, and only while nothing else on this Mac is changing Little Snitch. */
  run<T>(change: () => Promise<T>): Promise<T>;
  /**
   * Refuses to go on when the lock taken for the running change has been lost.
   * Called right before every command that changes Little Snitch.
   */
  assertLockHeld(): void;
  /**
   * Tells the queue that the running change started a command whose end was not
   * seen: it may still be at work as root. The lock is then kept after the
   * change, and every later change is refused, until the wait is over and no
   * such command is running any more.
   */
  commandMayStillRun(): void;
  /** True from `commandMayStillRun` until that wait has ended. */
  waitingForCommand(): boolean;
}

export interface ChangeQueueOptions {
  readonly lock: () => Promise<LockHandle>;
  /** True while a command that changes Little Snitch runs on this Mac, whoever started it. May fail when that cannot be told. */
  readonly commandRunning: () => Promise<boolean>;
  /** How long after a command that did not end in time no change is made, in milliseconds. */
  readonly settleMs: number;
  /** Runs under the lock before each change: the place to clear what an earlier change left behind. */
  readonly onLockTaken?: () => Promise<void>;
  readonly clock?: () => number;
}

const RECHECK_MS = 15_000;
const busy = (message: string): LittleSnitchError => new LittleSnitchError('busy', message);

export function createChangeQueue(options: ChangeQueueOptions): ChangeQueue {
  const clock = options.clock ?? ((): number => Date.now());
  let last: Promise<unknown> = Promise.resolve();
  let current: LockHandle | undefined;
  let marked = false;
  let waiting: { readonly since: number; readonly handle: LockHandle } | undefined;

  /** Ends the wait after a command that did not end in time, or says why it cannot end yet. */
  const settle = async (): Promise<void> => {
    if (waiting === undefined) {
      return;
    }
    const left = waiting.since + options.settleMs - clock();
    if (left > 0) {
      throw busy(
        'An earlier change did not end in time, and the command it started may still be running as root. ' +
          `This server changes nothing for another ${Math.ceil(left / 1000)} second(s), and nothing while that command runs. Read the configuration again before you ask for another change.`,
      );
    }
    if (await options.commandRunning()) {
      throw busy('The command of an earlier change that did not end in time is still running. This server changes nothing until it has ended.');
    }
    const { handle } = waiting;
    waiting = undefined;
    await handle.release().catch(() => undefined);
  };

  /** Gives the lock back by itself once the wait is over, so that other servers on this Mac are not held up until the next change here. */
  const settleLater = (ms: number): void => {
    const timer = setTimeout(() => {
      last = last.then(settle).catch(() => {
        if (waiting !== undefined) {
          settleLater(Math.min(RECHECK_MS, Math.max(options.settleMs, 250)));
        }
      });
    }, ms);
    timer.unref();
  };

  return {
    run<T>(change: () => Promise<T>): Promise<T> {
      const next = last.then(async () => {
        await settle();
        const handle = await options.lock();
        try {
          // A command left behind by a server that has gone, or run by hand in a terminal, would collide with this change.
          if (await options.commandRunning()) {
            throw busy('A command that changes Little Snitch is running on this Mac right now, started by something else. This server changes nothing until it has ended.');
          }
          await options.onLockTaken?.();
          current = handle;
          return await change();
        } finally {
          current = undefined;
          const keep = marked;
          marked = false;
          if (keep) {
            waiting = { since: clock(), handle };
            settleLater(options.settleMs + 50);
          } else {
            // Giving the lock back must not turn a finished change into an error.
            await handle.release().catch(() => undefined);
          }
        }
      });
      last = next.catch(() => undefined);
      return next;
    },
    assertLockHeld() {
      if (current === undefined || !current.isHeld()) {
        throw busy(
          'The lock that keeps changes apart was lost while this change was running, so another change to Little Snitch may have started. This server did not go on.',
        );
      }
    },
    commandMayStillRun() {
      marked = true;
    },
    waitingForCommand: () => marked || waiting !== undefined,
  };
}

export interface Context {
  readonly config: Config;
  readonly changes: ChangeQueue;
  readonly cli: LittleSnitchCli;
  readonly binary: BinaryChecker;
  readonly store: Store;
  readonly models: ModelCache;
  readonly touchId: () => Promise<boolean>;
  readonly now: () => Date;
  /** The macOS user this server runs as; new rules are made for this user. */
  readonly uid: number;
}

export interface ContextOverrides {
  readonly exec?: ExecFn;
  readonly now?: () => Date;
  readonly uid?: number;
  readonly touchId?: () => Promise<boolean>;
  readonly acquireLock?: AcquireLock;
  /** For tests: whether a command that changes Little Snitch is running. */
  readonly commandRunning?: () => Promise<boolean>;
}

export function createModelCache(cli: LittleSnitchCli, now: () => Date): ModelCache {
  let cached: { readonly model: JsonObject; readonly at: number } | undefined;
  const fresh = async (): Promise<{ model: JsonObject; text: string }> => {
    const text = await cli.exportModel();
    const model = parseModelText(text);
    cached = { model, at: now().getTime() };
    return { model, text };
  };
  return {
    fresh,
    async get(maxAgeMs) {
      if (cached !== undefined && now().getTime() - cached.at <= maxAgeMs) {
        return cached.model;
      }
      return (await fresh()).model;
    },
    put(model) {
      cached = { model, at: now().getTime() };
    },
    peek: () => cached?.model,
    clear() {
      cached = undefined;
    },
  };
}

/** The person's user id: when the server was started through sudo, the user who ran sudo, not root. */
export function currentUid(env: Readonly<Record<string, string | undefined>>, processUid: number): number {
  const sudoUid = Number(env['SUDO_UID']);
  return processUid === 0 && Number.isInteger(sudoUid) && sudoUid > 0 ? sudoUid : processUid;
}

export function createContext(config: Config, overrides: ContextOverrides = {}): Context {
  const exec = overrides.exec ?? execFile;
  const now = overrides.now ?? (() => new Date());
  const touchId = overrides.touchId ?? (() => touchIdConfigured());
  const binary = createBinaryChecker(config.cliPath, exec);
  const elevator = createElevator({ exec, config, touchIdConfigured: touchId, randomToken: () => randomBytes(16).toString('hex') });
  const uid = overrides.uid ?? currentUid(process.env, process.getuid?.() ?? 0);
  const cli = createCli({ exec, elevator, binary, config, uid });
  const store = createStore(config.dataDir, now);
  return {
    config,
    changes: createChangeQueue({
      lock: () => (overrides.acquireLock ?? acquireKernelLock)(config.lockFile),
      commandRunning: overrides.commandRunning ?? (() => changingCommandRunning(exec, config.cliPath)),
      settleMs: config.settleMs,
      onLockTaken: () => store.clearPending(),
    }),
    cli,
    binary,
    store,
    models: createModelCache(cli, now),
    touchId,
    now,
    uid,
  };
}
