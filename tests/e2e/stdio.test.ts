import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_LOCK_FILE } from '../../src/lock.js';
import { rulesOf } from '../../src/model/json.js';
import { parseModelText } from '../../src/model/json.js';
import { readFileSync } from 'node:fs';
import { installFake } from '../helpers/harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** Starts the built server the way an MCP client does: as a child process speaking over stdin and stdout. */
describe('the built server over stdio', () => {
  let dir: string;
  let client: Client;
  let stateDir: string;
  let stderr = '';

  beforeAll(async () => {
    // tests/global-setup.ts has built dist/index.js.
    dir = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-e2e-'));
    const fake = installFake(dir);
    stateDir = fake.stateDir;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, '--cli-path', fake.cliPath, '--elevation', 'none', '--data-dir', path.join(dir, 'data'), '--allow', 'rules'],
      // A home folder of its own, to see that the server puts nothing there.
      env: { HOME: dir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('introduces itself and says what it was started with', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'little-snitch-mcp-server', version: PACKAGE_VERSION });
    expect(stderr).toContain('root access "none", changes allowed: rules');
  });

  it('offers the reading tools and the allowed rule tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(12);
    expect(tools.map((tool) => tool.name)).toContain('add_rule');
    expect(tools.map((tool) => tool.name)).not.toContain('restore_backup');
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('adds a rule from start to finish, under the one lock every server on this Mac shares', async () => {
    const before = rulesOf(parseModelText(readFileSync(path.join(stateDir, 'model.json'), 'utf8'))).length;
    const result = await client.callTool({
      name: 'add_rule',
      arguments: { action: 'deny', process: '/usr/bin/curl', remote_hosts: ['blocked.example'] },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ applied: true, rule: { action: 'deny', remote: { kind: 'hosts', values: ['blocked.example'] } } });
    const model = parseModelText(readFileSync(path.join(stateDir, 'model.json'), 'utf8'));
    expect(rulesOf(model)).toHaveLength(before + 1);
    // The lock has one fixed place for the whole Mac. Nothing is put under the home folder the server was given.
    expect(existsSync(SYSTEM_LOCK_FILE)).toBe(true);
    expect(statSync(SYSTEM_LOCK_FILE).isFile()).toBe(true);
    expect(existsSync(path.join(dir, 'Library'))).toBe(false);
  });
});

describe('starting the built server', () => {
  it('stops with a clear message when an option is wrong', () => {
    const run = spawnSync(process.execPath, [ENTRY, '--elevation', 'root'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unknown elevation "root"');
    expect(run.stdout).toBe('');
  });

  it('prints its version', () => {
    const run = spawnSync(process.execPath, [ENTRY, '--version'], { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
  });
});
