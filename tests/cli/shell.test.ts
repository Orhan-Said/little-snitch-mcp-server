import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { adminDialogArgs, buildCompoundScript, parseCompoundOutput, shellQuote } from '../../src/cli/shell.js';

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
      ['-c', 'printf "first out"; printf "first err" 1>&2'],
      ['-c', 'echo second'],
    ], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([
      { code: 0, stdout: 'first out', stderr: 'first err' },
      { code: 0, stdout: 'second\n', stderr: '' },
    ]);
  });

  it('stops at the first command that fails and reports its exit code', () => {
    const script = buildCompoundScript('/bin/sh', [
      ['-c', 'echo "must be run as root!" 1>&2; exit 14'],
      ['-c', 'echo never'],
    ], TOKEN);
    const steps = parseCompoundOutput(runWithSh(script), TOKEN);
    expect(steps).toEqual([{ code: 14, stdout: '', stderr: 'must be run as root!' }]);
  });

  it('passes arguments with spaces and quotes through unchanged', () => {
    const awkward = `Home's "Work" profile; echo injected`;
    const script = buildCompoundScript('/usr/bin/printf', [['%s', awkward]], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)).toEqual([{ code: 0, stdout: awkward, stderr: '' }]);
  });

  it('keeps output that spans many lines intact', () => {
    const script = buildCompoundScript('/bin/sh', [['-c', 'printf "{\\n  \\"rules\\": []\\n}\\n"']], TOKEN);
    expect(parseCompoundOutput(runWithSh(script), TOKEN)[0]?.stdout).toBe('{\n  "rules": []\n}\n');
  });

  it('returns nothing when the marker is missing', () => {
    expect(parseCompoundOutput('some unrelated text\n', TOKEN)).toEqual([]);
  });

  it('refuses a marker that could collide with ordinary output', () => {
    expect(() => buildCompoundScript('/bin/echo', [['x']], 'short')).toThrow(/marker token/);
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
