import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminDialogArgs,
  buildCompoundScript,
  INPUT_CHANGED_EXIT,
  INPUT_CHANGED_MESSAGE,
  parseCompoundOutput,
  ROOT_PRIVATE_DIR,
  shellQuote,
} from '../../src/cli/shell.js';

const TOKEN = 'abcdefghijklmnop0123';

function runWithSh(script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
}

describe('shellQuote', () => {
  it('wraps a word in single quotes', () => {
    expect(shellQuote('export-model')).toBe(`'export-model'`);
  });

  it('keeps a single quote, spaces and shell characters literal', () => {
    const word = `it's $(rm -rf /) "x" ; \`id\` \\ *`;
    expect(runWithSh(`printf %s ${shellQuote(word)}`)).toBe(word);
  });

  it('refuses a NUL byte', () => {
    expect(() => shellQuote('a\0b')).toThrow(/NUL/);
  });
});

describe('buildCompoundScript and parseCompoundOutput', () => {
  it('returns each command\'s output, error text and exit code', () => {
    const script = buildCompoundScript('/bin/sh', [
      { args: ['-c', 'printf "first out"; printf "first err" 1>&2'] },
      { args: ['-c', 'echo second'] },
    ], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([
      { code: 0, stdout: 'first out', stderr: 'first err' },
      { code: 0, stdout: 'second\n', stderr: '' },
    ]);
  });

  it('stops at the first command that fails and reports its exit code', () => {
    const script = buildCompoundScript('/bin/sh', [
      { args: ['-c', 'echo "must be run as root!" 1>&2; exit 14'] },
      { args: ['-c', 'echo never'] },
    ], TOKEN);
    const steps = parseCompoundOutput(runWithSh(script), TOKEN);
    expect(steps).toEqual([{ code: 14, stdout: '', stderr: 'must be run as root!' }]);
  });

  it('passes arguments with spaces, quotes, line breaks and shell syntax through unchanged', () => {
    const awkward = `Home's "Work" profile; echo injected\n$(touch /tmp/lsmcp-should-not-exist) \`id\``;
    const script = buildCompoundScript('/usr/bin/printf', [{ args: ['%s', awkward] }], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([{ code: 0, stdout: awkward, stderr: '' }]);
  });

  it('keeps output that spans many lines intact', () => {
    const script = buildCompoundScript('/bin/sh', [{ args: ['-c', 'printf "{\\n  \\"rules\\": []\\n}\\n"'] }], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)[0]?.stdout).toBe('{\n  "rules": []\n}\n');
  });

  it('returns nothing when the marker is missing', () => {
    expect(parseCompoundOutput('some unrelated text\n', TOKEN)).toEqual([]);
  });

  it('refuses a marker that could collide with ordinary output', () => {
    expect(() => buildCompoundScript('/bin/echo', [{ args: ['x'] }], 'short')).toThrow(/marker token/);
  });
});

describe('a step with a checked input file', () => {
  let dir: string | undefined;
  const setup = (content: string): { file: string; privateDir: string; sha256: string } => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lsmcp shell's test-"));
    const file = path.join(dir, 'pending model.json');
    const privateDir = path.join(dir, 'private');
    execFileSync('/bin/mkdir', [privateDir]);
    writeFileSync(file, content);
    return { file, privateDir, sha256: createHash('sha256').update(content).digest('hex') };
  };
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the tool a private copy of the file when the checksum matches, then removes the copy', () => {
    const { file, privateDir, sha256 } = setup('{"rules":[1]}');
    // /bin/cat stands in for the tool: it prints the file it is given, and "--" plays the part of an option.
    const script = buildCompoundScript('/bin/cat', [{ args: ['--', file], input: { index: 1, sha256 } }, { args: ['/dev/null'] }], TOKEN, privateDir);
    expect(script).not.toContain(`'/bin/cat' '--' '${file}'`);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([
      { code: 0, stdout: '{"rules":[1]}', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    expect(readdirSync(privateDir)).toEqual([]);
  });

  it('runs nothing when the file is not the one that was written', () => {
    const { file, privateDir, sha256 } = setup('{"rules":[1]}');
    writeFileSync(file, '{"rules":[{"action":"allow","process":"any","remote":"any"}]}');
    const script = buildCompoundScript('/bin/cat', [{ args: ['--', file], input: { index: 1, sha256 } }, { args: ['/dev/null'] }], TOKEN, privateDir);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([{ code: INPUT_CHANGED_EXIT, stdout: '', stderr: INPUT_CHANGED_MESSAGE }]);
    expect(readdirSync(privateDir)).toEqual([]);
  });

  it('runs nothing when the file is missing or the private folder cannot be used', () => {
    const { file, privateDir, sha256 } = setup('{}');
    const gone = buildCompoundScript('/bin/cat', [{ args: ['--', `${file}.missing`], input: { index: 1, sha256 } }], TOKEN, privateDir);
    expect(parseCompoundOutput(runWithSh(gone), TOKEN)[0]?.code).toBe(INPUT_CHANGED_EXIT);
    const noFolder = buildCompoundScript('/bin/cat', [{ args: ['--', file], input: { index: 1, sha256 } }], TOKEN, `${privateDir}/nowhere`);
    expect(parseCompoundOutput(runWithSh(noFolder), TOKEN)[0]?.code).toBe(INPUT_CHANGED_EXIT);
  });

  it('reports the tool\'s own exit code and still removes the copy', () => {
    const { file, privateDir, sha256 } = setup('{}');
    const script = buildCompoundScript('/bin/sh', [{ args: ['-c', 'echo refused 1>&2; exit 5', 'sh', file], input: { index: 3, sha256 } }], TOKEN, privateDir);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([{ code: 5, stdout: '', stderr: 'refused' }]);
    expect(readdirSync(privateDir)).toEqual([]);
  });

  it('copies into root\'s own folder by default and refuses a malformed checksum', () => {
    expect(ROOT_PRIVATE_DIR).toBe('/private/var/root');
    expect(buildCompoundScript('/bin/cat', [{ args: ['/tmp/x'], input: { index: 0, sha256: 'a'.repeat(64) } }], TOKEN)).toContain(
      `/usr/bin/mktemp -d '/private/var/root/lsmcp.XXXXXXXX'`,
    );
    expect(() => buildCompoundScript('/bin/cat', [{ args: ['/tmp/x'], input: { index: 0, sha256: "'; rm -rf /; '" } }], TOKEN)).toThrow(/SHA-256/);
    expect(() => buildCompoundScript('/bin/cat', [{ args: [], input: { index: 0, sha256: 'a'.repeat(64) } }], TOKEN)).toThrow(/existing argument/);
  });
});

describe('adminDialogArgs', () => {
  it('passes the command and the prompt as arguments, never inside the script', () => {
    const args = adminDialogArgs(`'/bin/echo' 'x'`, 'Please approve');
    expect(args.slice(-3)).toEqual(['--', `'/bin/echo' 'x'`, 'Please approve']);
    const source = args.slice(0, -3).filter((part) => part !== '-e').join('\n');
    expect(source).toContain('with administrator privileges');
    expect(source).toContain('with prompt (item 2 of argv)');
    expect(source).not.toContain('/bin/echo');
  });
});
