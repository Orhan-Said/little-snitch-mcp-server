import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODESIGN_PATH, createBinaryChecker, type StatFn } from '../../src/cli/binary.js';
import { execFile } from '../../src/cli/exec.js';
import { DEFAULT_CLI_PATH } from '../../src/config.js';
import { fakeExec } from '../helpers/fakeExec.js';

const CLI = '/Applications/Little Snitch.app/Contents/Components/littlesnitch';
const rootOwned: StatFn = async () => ({ isFile: true, isSymlink: false, uid: 0, mode: 0o100755, ino: 1, mtimeMs: 10, size: 100 });

describe('createBinaryChecker', () => {
  it('accepts a root-owned tool with a valid signature', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    const checker = createBinaryChecker(CLI, exec, rootOwned);
    await expect(checker.assertTrusted()).resolves.toBeUndefined();
    expect(calls[0]?.file).toBe(CODESIGN_PATH);
    expect(calls[0]?.args.at(-1)).toBe(CLI);
    expect(calls[0]?.args.join(' ')).toContain('MLZF7K7B5R');
  });

  it('remembers a good signature until the file changes', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    let mtimeMs = 10;
    const checker = createBinaryChecker(CLI, exec, async () => ({ isFile: true, isSymlink: false, uid: 0, mode: 0o100755, ino: 1, mtimeMs, size: 100 }));
    await checker.assertTrusted();
    await checker.assertTrusted();
    expect(calls).toHaveLength(1);
    mtimeMs = 11;
    await checker.assertTrusted();
    expect(calls).toHaveLength(2);
  });

  it('refuses a tool that is missing', async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    const checker = createBinaryChecker(CLI, exec, async () => null);
    await expect(checker.assertTrusted()).rejects.toMatchObject({ kind: 'not-installed' });
  });

  it('refuses a tool that is not owned by root', async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    const checker = createBinaryChecker(CLI, exec, async () => ({ isFile: true, isSymlink: false, uid: 501, mode: 0o100755, ino: 1, mtimeMs: 10, size: 100 }));
    await expect(checker.assertTrusted()).rejects.toMatchObject({ kind: 'untrusted-binary' });
  });

  it('refuses a tool others can write to', async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    const checker = createBinaryChecker(CLI, exec, async () => ({ isFile: true, isSymlink: false, uid: 0, mode: 0o100775, ino: 1, mtimeMs: 10, size: 100 }));
    const check = await checker.inspect(false);
    expect(check.writableByOthers).toBe(true);
    await expect(checker.assertTrusted()).rejects.toMatchObject({ kind: 'untrusted-binary' });
  });

  it('refuses a tool with the wrong signature', async () => {
    const { exec } = fakeExec(() => ({ code: 3, stderr: 'test-requirement: code failed to satisfy specified code requirement(s)' }));
    const checker = createBinaryChecker(CLI, exec, rootOwned);
    const check = await checker.inspect(true);
    expect(check.signedByObjectiveDevelopment).toBe(false);
    await expect(checker.assertTrusted()).rejects.toMatchObject({ kind: 'untrusted-binary' });
  });

  it('refuses a symbolic link, even to a good file', async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    const checker = createBinaryChecker(CLI, exec, async () => ({ isFile: true, isSymlink: true, uid: 0, mode: 0o100755, ino: 1, mtimeMs: 10, size: 100 }));
    await expect(checker.assertTrusted()).rejects.toMatchObject({ kind: 'untrusted-binary' });
    expect((await checker.inspect(false)).problems[0]).toContain('symbolic link');
  });

  it('does not check the signature unless asked', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    const check = await createBinaryChecker(CLI, exec, rootOwned).inspect(false);
    expect(check.signedByObjectiveDevelopment).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(!existsSync(DEFAULT_CLI_PATH))('the installed Little Snitch tool', () => {
  it('passes the ownership and signature checks', async () => {
    const check = await createBinaryChecker(DEFAULT_CLI_PATH, execFile).inspect(true);
    expect(check).toEqual({ exists: true, ownedByRoot: true, writableByOthers: false, signedByObjectiveDevelopment: true, problems: [] });
  });

  it('rejects another signed program under the same checks', async () => {
    const check = await createBinaryChecker('/bin/ls', execFile).inspect(true);
    expect(check.signedByObjectiveDevelopment).toBe(false);
  });
});
