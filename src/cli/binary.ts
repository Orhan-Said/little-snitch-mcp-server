import { lstat, stat } from 'node:fs/promises';
import { LittleSnitchError } from '../errors.js';
import type { ExecFn } from './exec.js';

/** Objective Development's Apple Developer team, which signs Little Snitch. */
export const OBDEV_TEAM_ID = 'MLZF7K7B5R';
export const CODESIGN_PATH = '/usr/bin/codesign';
export const CODE_REQUIREMENT = `identifier "littlesnitch" and anchor apple generic and certificate leaf[subject.OU] = "${OBDEV_TEAM_ID}"`;

export interface BinaryCheck {
  readonly exists: boolean;
  readonly ownedByRoot: boolean;
  readonly writableByOthers: boolean;
  /** Null when the signature was not checked. */
  readonly signedByObjectiveDevelopment: boolean | null;
  readonly problems: readonly string[];
}

interface FileFacts {
  readonly isFile: boolean;
  /** True when the path itself is a symbolic link, whatever it points to. */
  readonly isSymlink: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export type StatFn = (file: string) => Promise<FileFacts | null>;

const realStat: StatFn = async (file) => {
  try {
    const [info, link] = await Promise.all([stat(file), lstat(file)]);
    return { isFile: info.isFile(), isSymlink: link.isSymbolicLink(), uid: info.uid, mode: info.mode, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
};

export interface BinaryChecker {
  /** Describes the binary without throwing. */
  inspect(checkSignature: boolean): Promise<BinaryCheck>;
  /** Throws unless the binary is safe to run as root. */
  assertTrusted(): Promise<void>;
}

/**
 * Before anything is run as root, the program must be the real Little Snitch
 * tool: owned by root, not writable by anyone else, and signed by Objective
 * Development. The signature result is remembered until the file changes.
 */
export function createBinaryChecker(cliPath: string, exec: ExecFn, statFile: StatFn = realStat): BinaryChecker {
  let verifiedFingerprint: string | undefined;

  const inspect = async (checkSignature: boolean): Promise<BinaryCheck> => {
    const facts = await statFile(cliPath);
    if (facts === null || !facts.isFile) {
      return {
        exists: false,
        ownedByRoot: false,
        writableByOthers: false,
        signedByObjectiveDevelopment: null,
        problems: [`The Little Snitch command-line tool was not found at ${cliPath}.`],
      };
    }
    const ownedByRoot = facts.uid === 0;
    const writableByOthers = (facts.mode & 0o022) !== 0;
    const fingerprint = `${facts.ino}:${facts.mtimeMs}:${facts.size}`;
    let signed: boolean | null = null;
    if (checkSignature) {
      if (verifiedFingerprint === fingerprint) {
        signed = true;
      } else {
        const result = await exec(CODESIGN_PATH, ['--verify', '--strict', `-R=${CODE_REQUIREMENT}`, cliPath], { timeoutMs: 30_000 });
        signed = result.code === 0;
        verifiedFingerprint = signed ? fingerprint : undefined;
      }
    }
    const problems = [
      // A link could be pointed somewhere else between this check and the run.
      ...(facts.isSymlink ? [`${cliPath} is a symbolic link. Give the path of the real file.`] : []),
      ...(ownedByRoot ? [] : [`${cliPath} is not owned by root.`]),
      ...(writableByOthers ? [`${cliPath} can be changed by users other than root.`] : []),
      ...(signed === false ? [`${cliPath} is not signed by Objective Development (team ${OBDEV_TEAM_ID}).`] : []),
    ];
    return { exists: true, ownedByRoot, writableByOthers, signedByObjectiveDevelopment: signed, problems };
  };

  const assertTrusted = async (): Promise<void> => {
    const check = await inspect(true);
    if (!check.exists) {
      throw new LittleSnitchError('not-installed', check.problems.join(' '), {
        remedy: 'Install Little Snitch 6 from https://obdev.at/littlesnitch, or set the CLI path if it lives elsewhere.',
      });
    }
    if (check.problems.length > 0) {
      throw new LittleSnitchError('untrusted-binary', `Refusing to run the tool as root. ${check.problems.join(' ')}`, {
        remedy: 'Reinstall Little Snitch from Objective Development. This check cannot be switched off.',
      });
    }
  };

  return { inspect, assertTrusted };
}
