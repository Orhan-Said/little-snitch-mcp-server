import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

type Json = Record<string, unknown>;

function readJson(relative: string): Json {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8')) as Json;
}

interface PackageJson {
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly bundleDependencies?: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly bin: Readonly<Record<string, string>>;
}

const pkg = readJson('package.json') as unknown as PackageJson;

const NPM_SOURCE = { source: 'npm', package: 'little-snitch-mcp-server', version: pkg.version };

/** Set by each plugin, so that a variable inherited from the person's shell cannot switch the approval off. */
const APPROVAL_PINNED = { LITTLE_SNITCH_MCP_ELEVATION: 'auto', LITTLE_SNITCH_MCP_UNATTENDED_WRITES: 'false' };

describe('the Claude Code plugin', () => {
  const manifest = readJson('.claude-plugin/plugin.json');

  it('names the plugin, its version and its skills folder', () => {
    expect(manifest).toMatchObject({ name: 'little-snitch', version: pkg.version, skills: './skills' });
  });

  it('starts the server from its own package, with changes taken from the plugin option and the approval pinned on', () => {
    expect(manifest['mcpServers']).toEqual({
      'little-snitch': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'],
        env: { ...APPROVAL_PINNED, LITTLE_SNITCH_MCP_ALLOW: '${user_config.allow}' },
      },
    });
  });

  it('asks which changes to allow and lets the user leave it empty', () => {
    const options = manifest['userConfig'] as Record<string, Json> | undefined;
    const allow = options?.['allow'];
    expect(allow).toMatchObject({ type: 'string', default: '' });
    expect(typeof allow?.['title']).toBe('string');
    for (const word of ['switches', 'rules', 'restore', 'all']) {
      expect(String(allow?.['description'])).toContain(word);
    }
    expect(allow?.['required']).not.toBe(true);
  });
});

describe('the Claude Code marketplace', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');

  it('offers one plugin, taken from npm at the package version', () => {
    expect(marketplace).toMatchObject({ name: 'little-snitch', owner: { name: 'Orhan Said' } });
    expect(marketplace['plugins']).toHaveLength(1);
    expect(marketplace['plugins']).toMatchObject([{ name: 'little-snitch', source: NPM_SOURCE }]);
  });
});

describe('the Codex plugin', () => {
  const manifest = readJson('.codex-plugin/plugin.json');

  it('names the plugin, its version, its skills and its server file', () => {
    expect(manifest).toMatchObject({
      name: 'little-snitch',
      version: pkg.version,
      author: { name: 'Orhan Said' },
      skills: './skills',
      mcpServers: './.codex-plugin/mcp.json',
    });
    expect(String(manifest['description']).length).toBeGreaterThan(20);
  });

  it('describes itself for the Codex plugin browser within its length limits', () => {
    const face = manifest['interface'] as Json;
    // The Codex plugin's server only reads; changes need a registration of the person's own.
    expect(face).toMatchObject({ displayName: 'Little Snitch', capabilities: ['Interactive', 'Read'] });
    // Its server only reads, so nothing a Codex user sees first may promise changes.
    expect(face['shortDescription']).toBe('Read Little Snitch firewall');
    expect(String(face['shortDescription']).length).toBeLessThanOrEqual(30);
    expect(manifest['description']).toBe('Read the Little Snitch firewall on a Mac: rules, traffic and its log. Changes need a registration of your own.');
    expect(Array.isArray(face['defaultPrompt']) && face['defaultPrompt'].length > 0).toBe(true);
  });

  it('starts the server read-only from the installed plugin folder, with the approval pinned on', () => {
    expect(readJson('.codex-plugin/mcp.json')).toEqual({
      mcpServers: {
        'little-snitch': {
          command: 'node',
          args: ['./dist/index.js'],
          cwd: '.',
          env: { ...APPROVAL_PINNED, LITTLE_SNITCH_MCP_ALLOW: '' },
          startup_timeout_sec: 30,
        },
      },
    });
  });
});

describe('the Codex marketplace', () => {
  it('offers one plugin, taken from npm at the package version', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json');
    expect(marketplace).toMatchObject({ name: 'little-snitch', interface: { displayName: 'Little Snitch' } });
    expect(marketplace['plugins']).toEqual([
      {
        name: 'little-snitch',
        source: NPM_SOURCE,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      },
    ]);
  });
});

describe('the npm package as a plugin', () => {
  it('ships both plugin manifests and the skills', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['.claude-plugin/plugin.json', '.codex-plugin', 'skills', 'dist']));
  });

  it('carries its runtime dependencies inside, because Codex installs none', () => {
    expect([...(pkg.bundleDependencies ?? [])].sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it('points both plugins at the file it ships as its command', () => {
    expect(pkg.bin['little-snitch-mcp-server']).toBe('dist/index.js');
  });

  it('updates every version number when npm version runs', () => {
    expect(pkg.scripts['version']).toBe('node scripts/sync-version.mjs');
  });
});
