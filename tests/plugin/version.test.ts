import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { syncVersion, VERSION_PIN } from '../../scripts/sync-version.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VERSION = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const SCRIPT = path.join(ROOT, 'scripts', 'sync-version.mjs');

function markdownUnder(relativeDir: string): readonly string[] {
  const full = path.join(ROOT, relativeDir);
  if (!existsSync(full)) {
    return [];
  }
  return readdirSync(full, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(relativeDir, name));
}

describe('version pins in the repository', () => {
  it('name the package version in the README and in the skill', () => {
    const files = ['README.md', ...markdownUnder('skills')];
    const pins = files.flatMap((file) => readFileSync(path.join(ROOT, file), 'utf8').match(VERSION_PIN) ?? []);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([`little-snitch-mcp-server@${VERSION}`]));
  });
});

describe('syncVersion', () => {
  let dir = '';

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, content: string): void {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  function json(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  function seed(version: string): void {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-version-'));
    const npm = { source: 'npm', package: 'little-snitch-mcp-server', version };
    write('.claude-plugin/plugin.json', json({ name: 'little-snitch', version }));
    write('.claude-plugin/marketplace.json', json({ name: 'little-snitch', plugins: [{ name: 'little-snitch', source: npm }] }));
    write('.codex-plugin/plugin.json', json({ name: 'little-snitch', version }));
    write(
      '.agents/plugins/marketplace.json',
      json({
        name: 'little-snitch',
        plugins: [
          { name: 'little-snitch', source: npm },
          { name: 'other', source: { source: 'npm', package: 'other-package', version: '3.0.0' } },
        ],
      }),
    );
    write('README.md', `npx -y little-snitch-mcp-server@${version}\nor little-snitch-mcp-server@${version} again\n`);
    write('skills/little-snitch/references/setup.md', `Run little-snitch-mcp-server@${version}.\n`);
  }

  function read(relative: string): string {
    return readFileSync(path.join(dir, relative), 'utf8');
  }

  it('writes the new version into every manifest, marketplace and pin, and names each file it changed', () => {
    seed('0.0.1');
    const changed = syncVersion(dir, '9.9.9');
    expect([...changed].sort()).toEqual(
      [
        '.agents/plugins/marketplace.json',
        '.claude-plugin/marketplace.json',
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        'README.md',
        path.join('skills', 'little-snitch', 'references', 'setup.md'),
      ].sort(),
    );
    expect(JSON.parse(read('.claude-plugin/plugin.json'))).toMatchObject({ version: '9.9.9' });
    expect(JSON.parse(read('.codex-plugin/plugin.json'))).toMatchObject({ version: '9.9.9' });
    expect(JSON.parse(read('.claude-plugin/marketplace.json'))).toMatchObject({ plugins: [{ source: { version: '9.9.9' } }] });
    expect(JSON.parse(read('.agents/plugins/marketplace.json'))).toMatchObject({
      plugins: [{ source: { version: '9.9.9' } }, { source: { package: 'other-package', version: '3.0.0' } }],
    });
    expect(read('README.md')).toBe('npx -y little-snitch-mcp-server@9.9.9\nor little-snitch-mcp-server@9.9.9 again\n');
    expect(read('skills/little-snitch/references/setup.md')).toBe('Run little-snitch-mcp-server@9.9.9.\n');
  });

  it('changes nothing the second time', () => {
    seed('0.0.1');
    syncVersion(dir, '9.9.9');
    expect(syncVersion(dir, '9.9.9')).toEqual([]);
  });

  it('refuses a value that is not a version', () => {
    seed('0.0.1');
    expect(() => syncVersion(dir, 'latest')).toThrow(/not a version/);
    expect(read('README.md')).toContain('@0.0.1');
  });

  it('run by npm version, takes the version from package.json and stages every file it changed', () => {
    seed('0.0.1');
    write('package.json', json({ name: 'little-snitch-mcp-server', version: '9.9.9' }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    expect(output).toContain('Version 9.9.9 written to');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    expect(staged.sort()).toEqual(
      [
        '.agents/plugins/marketplace.json',
        '.claude-plugin/marketplace.json',
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        'README.md',
        'skills/little-snitch/references/setup.md',
      ].sort(),
    );
  });

  it('outside a git repository, writes the files and says to add them', () => {
    seed('0.0.1');
    write('package.json', json({ name: 'little-snitch-mcp-server', version: '9.9.9' }));
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
    expect(output).toContain('Add these files to the release commit.');
    expect(read('README.md')).toContain('@9.9.9');
  });

  it('refuses to run when a manifest is missing, so no release skips one', () => {
    seed('0.0.1');
    rmSync(path.join(dir, '.codex-plugin'), { recursive: true });
    expect(() => syncVersion(dir, '9.9.9')).toThrow(/\.codex-plugin\/plugin\.json is missing/);
    expect(read('README.md')).toContain('@0.0.1');
  });
});
