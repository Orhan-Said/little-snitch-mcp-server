import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Everything the package may hold at its top level. Anything else (src, tests, coverage, a backup) is a mistake. */
const ALLOWED_TOP_LEVEL = [
  '.claude-plugin',
  '.codex-plugin',
  'skills',
  'dist',
  'node_modules',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
];

const READING_TOOLS = [
  'create_backup',
  'get_log',
  'get_preferences',
  'get_status',
  'get_traffic',
  'list_backups',
  'list_profiles',
  'list_rule_groups',
  'list_rules',
];

interface PackResult {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
}

/**
 * Packs the package the way npm publishes it, unpacks it outside the
 * repository, and starts the server from there as a plugin client would. A
 * client that installs no dependencies must still find them in the package.
 */
describe('the packed package', () => {
  let work = '';
  let unpacked = '';
  let packed: PackResult;
  let client: Client;
  let stderr = '';

  beforeAll(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-pack-'));
    const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const results = JSON.parse(output) as readonly PackResult[];
    expect(results).toHaveLength(1);
    packed = results[0] as PackResult;
    execFileSync('tar', ['-xzf', path.join(work, packed.filename), '-C', work]);
    unpacked = path.join(work, 'package');

    const home = path.join(work, 'home');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(unpacked, 'dist', 'index.js')],
      cwd: work,
      env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    client = new Client({ name: 'package-check', version: '1.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('holds only what a plugin needs at its top level', () => {
    const entries = readdirSync(unpacked);
    expect(entries.filter((entry) => !ALLOWED_TOP_LEVEL.includes(entry))).toEqual([]);
    expect(readdirSync(path.join(unpacked, '.claude-plugin'))).toEqual(['plugin.json']);
  });

  it('ships the server, both plugin manifests and the skill', () => {
    for (const file of [
      'dist/index.js',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      '.codex-plugin/mcp.json',
      'skills/little-snitch/SKILL.md',
    ]) {
      expect(existsSync(path.join(unpacked, file)), file).toBe(true);
    }
  });

  it('carries its runtime dependencies inside', () => {
    for (const dependency of ['@modelcontextprotocol/sdk', 'lossless-json', 'zod']) {
      expect(existsSync(path.join(unpacked, 'node_modules', dependency, 'package.json')), dependency).toBe(true);
    }
  });

  it('stays small enough to download quickly', () => {
    expect(packed.size).toBeLessThan(10_000_000);
    expect(packed.unpackedSize).toBeLessThan(40_000_000);
  });

  it('starts from the unpacked folder, read-only, and offers only the reading tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(READING_TOOLS);
    expect(stderr).toContain('changes allowed: none (read-only)');
  });
});
