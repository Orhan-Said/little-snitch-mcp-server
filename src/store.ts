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
  /**
   * "applied": made and proven by reading back. "accepted": Little Snitch took the
   * request and nothing else changed, but the configuration does not show the result.
   */
  readonly outcome: 'applied' | 'accepted' | 'failed' | 'rolled-back' | 'not-rolled-back';
  readonly method?: string;
  readonly backup?: string;
  readonly detail?: string;
}

export interface Store {
  /**
   * Saves a copy of the configuration. Returns where it is. Only the 50 newest
   * backups are kept; `keep` names backups that must not be removed this time.
   */
  writeBackup(text: string, label: string, keep?: readonly string[]): Promise<BackupInfo>;
  listBackups(): Promise<readonly BackupInfo[]>;
  /** Reads a backup this server made, by file name only. */
  readBackup(name: string): Promise<{ readonly info: BackupInfo; readonly text: string }>;
  /** Writes the configuration that is about to be applied; the caller removes it afterwards. */
  writePending(text: string): Promise<string>;
  /** Never fails. Returns false when the file is still there afterwards. */
  removePending(file: string): Promise<boolean>;
  /**
   * Removes every file a change left in the pending folder. Call it only while
   * holding the change lock, when no change can be using one. Never fails.
   */
  clearPending(): Promise<void>;
  /**
   * Writes one line to the change log. Never fails, because a full disk must
   * not turn a finished change into an error. Returns false when the line could not be written.
   */
  audit(entry: AuditEntry): Promise<boolean>;
  readonly dir: string;
}

const KEEP_BACKUPS = 50;
const BACKUP_NAME = /^\d{8}T\d{6}Z-[a-z0-9-]{1,40}-[0-9a-f]{6}\.json$/;
const PENDING_NAME = /^[0-9a-f]{16}\.json$/;
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

    async writeBackup(text, label, keep = []) {
      await ensure(dataDir);
      await ensure(backupsDir);
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'backup';
      const name = `${stamp}-${slug}-${randomBytes(3).toString('hex')}.json`;
      const file = path.join(backupsDir, name);
      await writeFile(file, text, { mode: 0o600, flag: 'wx' });
      const all = await listBackups();
      const surplus = all.slice(KEEP_BACKUPS).filter((old) => !keep.includes(old.name));
      await Promise.all(surplus.map((old) => rm(old.path, { force: true }).catch(() => undefined)));
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
      if (path.dirname(file) !== pendingDir) {
        return false;
      }
      try {
        await rm(file, { force: true });
        return true;
      } catch {
        return false;
      }
    },

    async clearPending() {
      const names = await readdir(pendingDir).catch(() => [] as string[]);
      await Promise.all(names.filter((name) => PENDING_NAME.test(name)).map((name) => rm(path.join(pendingDir, name), { force: true }).catch(() => undefined)));
    },

    async audit(entry) {
      try {
        await ensure(dataDir);
        const file = path.join(dataDir, 'changes.log');
        await appendFile(file, `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
