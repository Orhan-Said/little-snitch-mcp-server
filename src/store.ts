import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LittleSnitchError } from './errors.js';

export interface BackupInfo {
  readonly name: string;
  readonly path: string;
  readonly created: string;
  readonly bytes: number;
}

export interface AuditEntry {
  readonly tool: string;
  readonly summary: string;
  readonly outcome: 'applied' | 'failed' | 'rolled-back' | 'not-rolled-back';
  readonly method?: string;
  readonly backup?: string;
  readonly detail?: string;
}

export interface Store {
  /** Saves a copy of the configuration before a change. Returns where it is. */
  writeBackup(text: string, label: string): Promise<BackupInfo>;
  listBackups(): Promise<readonly BackupInfo[]>;
  /** Reads a backup this server made, by file name only. */
  readBackup(name: string): Promise<{ readonly info: BackupInfo; readonly text: string }>;
  /** Writes the configuration that is about to be applied; the caller removes it afterwards. */
  writePending(text: string): Promise<string>;
  removePending(file: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /**
   * Takes the lock that keeps two changes from running at once, also when two
   * copies of this server run. Returns the function that gives it back.
   * Throws "busy" when another change holds it.
   */
  lock(): Promise<() => Promise<void>>;
  readonly dir: string;
}

const KEEP_BACKUPS = 50;
/** A lock older than this belongs to a change that cannot still be running: approvals time out after five minutes each. */
const LOCK_STALE_MS = 20 * 60_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
const BACKUP_NAME = /^\d{8}T\d{6}Z-[a-z0-9-]{1,40}-[0-9a-f]{6}\.json$/;

/**
 * Backups hold the whole firewall configuration, so the folder is readable by
 * its owner only (0700) and each file is 0600.
 */
export function createStore(dataDir: string, now: () => Date = () => new Date()): Store {
  const backupsDir = path.join(dataDir, 'backups');
  const pendingDir = path.join(dataDir, 'pending');

  const ensure = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  };

  const info = async (name: string): Promise<BackupInfo> => {
    const file = path.join(backupsDir, name);
    const facts = await stat(file);
    return { name, path: file, created: facts.mtime.toISOString(), bytes: facts.size };
  };

  const listBackups = async (): Promise<readonly BackupInfo[]> => {
    let names: string[];
    try {
      names = await readdir(backupsDir);
    } catch {
      return [];
    }
    const valid = names.filter((name) => BACKUP_NAME.test(name)).sort().reverse();
    return Promise.all(valid.map(info));
  };

  return {
    dir: dataDir,

    async writeBackup(text, label) {
      await ensure(dataDir);
      await ensure(backupsDir);
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'backup';
      const name = `${stamp}-${slug}-${randomBytes(3).toString('hex')}.json`;
      const file = path.join(backupsDir, name);
      await writeFile(file, text, { mode: 0o600, flag: 'wx' });
      const all = await listBackups();
      await Promise.all(all.slice(KEEP_BACKUPS).map((old) => rm(old.path, { force: true })));
      return info(name);
    },

    listBackups,

    async readBackup(name) {
      if (!BACKUP_NAME.test(name)) {
        throw new LittleSnitchError('invalid-input', 'Give the backup by its file name, as list_backups shows it.');
      }
      try {
        return { info: await info(name), text: await readFile(path.join(backupsDir, name), 'utf8') };
      } catch {
        throw new LittleSnitchError('not-found', `There is no backup called ${name}.`);
      }
    },

    async writePending(text) {
      await ensure(dataDir);
      await ensure(pendingDir);
      const file = path.join(pendingDir, `${randomBytes(8).toString('hex')}.json`);
      await writeFile(file, text, { mode: 0o600, flag: 'wx' });
      return file;
    },

    async removePending(file) {
      if (path.dirname(file) === pendingDir) {
        await rm(file, { force: true });
      }
    },

    async lock() {
      await ensure(dataDir);
      const file = path.join(dataDir, 'change.lock');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await writeFile(file, JSON.stringify({ pid: process.pid, since: now().toISOString() }), { mode: 0o600, flag: 'wx' });
          return async () => {
            await rm(file, { force: true });
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
        let holder: { pid?: unknown; since?: unknown } = {};
        try {
          holder = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown; since?: unknown };
        } catch {
          // An unreadable lock file is treated as left over.
        }
        const since = typeof holder.since === 'string' ? Date.parse(holder.since) : Number.NaN;
        const fresh = !Number.isNaN(since) && now().getTime() - since < LOCK_STALE_MS;
        if (typeof holder.pid === 'number' && fresh && processIsAlive(holder.pid)) {
          throw new LittleSnitchError('busy', `Another change to Little Snitch is in progress (started ${String(holder.since)}). Try again when it has finished.`);
        }
        // Left over from a server that stopped in the middle of a change.
        await rm(file, { force: true });
      }
      throw new LittleSnitchError('busy', 'Another change to Little Snitch is in progress. Try again when it has finished.');
    },

    async audit(entry) {
      await ensure(dataDir);
      const file = path.join(dataDir, 'changes.log');
      await appendFile(file, `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
    },
  };
}
