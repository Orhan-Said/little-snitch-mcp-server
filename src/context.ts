import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { createBinaryChecker, type BinaryChecker } from './cli/binary.js';
import { createElevator, touchIdConfigured } from './cli/elevation.js';
import { execFile, type ExecFn } from './cli/exec.js';
import { createCli, type LittleSnitchCli } from './cli/littlesnitch.js';
import { parseModelText, type JsonObject } from './model/json.js';
import { createStore, type Store } from './store.js';

export interface ModelCache {
  /** The configuration, read again unless a copy at most `maxAgeMs` old is at hand. */
  get(maxAgeMs: number): Promise<JsonObject>;
  /** Always reads the configuration again. Returns the text as well, for backups. */
  fresh(): Promise<{ readonly model: JsonObject; readonly text: string }>;
  /** Stores the configuration as read back after a change. */
  put(model: JsonObject): void;
  clear(): void;
}

export interface ChangeQueue {
  /** Runs one change at a time: after every change this server already started, and only while no other server is changing anything. */
  run<T>(change: () => Promise<T>): Promise<T>;
}

export function createChangeQueue(store: Pick<Store, 'lock'>): ChangeQueue {
  let last: Promise<unknown> = Promise.resolve();
  return {
    run<T>(change: () => Promise<T>): Promise<T> {
      const next = last.then(async () => {
        const release = await store.lock();
        try {
          return await change();
        } finally {
          await release();
        }
      });
      last = next.catch(() => undefined);
      return next;
    },
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
  const cli = createCli({ exec, elevator, binary, config });
  const store = createStore(config.dataDir, now);
  return {
    config,
    changes: createChangeQueue(store),
    cli,
    binary,
    store,
    models: createModelCache(cli, now),
    touchId,
    now,
    uid: overrides.uid ?? currentUid(process.env, process.getuid?.() ?? 0),
  };
}
