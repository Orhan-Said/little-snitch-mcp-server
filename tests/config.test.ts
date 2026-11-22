import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CLI_PATH, loadConfig } from '../src/config.js';

const HOME = '/Users/someone';

describe('loadConfig', () => {
  it('reads nothing but the defaults when nothing is set', () => {
    const config = loadConfig({}, [], HOME);
    expect(config.cliPath).toBe(DEFAULT_CLI_PATH);
    expect(config.cliPathIsDefault).toBe(true);
    expect(config.elevation).toBe('auto');
    expect([...config.allow]).toEqual([]);
    expect(config.unattendedWrites).toBe(false);
    expect(config.dataDir).toBe('/Users/someone/Library/Application Support/little-snitch-mcp-server');
  });

  it('takes capabilities from the environment', () => {
    const config = loadConfig({ LITTLE_SNITCH_MCP_ALLOW: 'switches, rules' }, [], HOME);
    expect([...config.allow].sort()).toEqual(['rules', 'switches']);
  });

  it('expands "all" to every capability', () => {
    const config = loadConfig({}, ['--allow', 'all'], HOME);
    expect([...config.allow].sort()).toEqual(['restore', 'rules', 'switches']);
  });

  it('lets a flag win over the environment', () => {
    const config = loadConfig({ LITTLE_SNITCH_MCP_ELEVATION: 'dialog' }, ['--elevation=sudo'], HOME);
    expect(config.elevation).toBe('sudo');
  });

  it('treats a bare --unattended-writes as true', () => {
    expect(loadConfig({}, ['--unattended-writes'], HOME).unattendedWrites).toBe(true);
    expect(loadConfig({ LITTLE_SNITCH_MCP_UNATTENDED_WRITES: '0' }, [], HOME).unattendedWrites).toBe(false);
  });

  it('marks an overridden CLI path as not the default', () => {
    const config = loadConfig({}, ['--cli-path', '/opt/fake/littlesnitch'], HOME);
    expect(config.cliPath).toBe('/opt/fake/littlesnitch');
    expect(config.cliPathIsDefault).toBe(false);
  });

  it('refuses a capability it does not know', () => {
    expect(() => loadConfig({ LITTLE_SNITCH_MCP_ALLOW: 'rules,everything' }, [], HOME)).toThrow(ConfigError);
    expect(() => loadConfig({ LITTLE_SNITCH_MCP_ALLOW: 'rules,everything' }, [], HOME)).toThrow(/everything/);
  });

  it('refuses an unknown elevation, option, boolean or relative path', () => {
    expect(() => loadConfig({ LITTLE_SNITCH_MCP_ELEVATION: 'root' }, [], HOME)).toThrow(/Unknown elevation "root"/);
    expect(() => loadConfig({}, ['--force'], HOME)).toThrow(/Unknown option "--force"/);
    expect(() => loadConfig({ LITTLE_SNITCH_MCP_UNATTENDED_WRITES: 'maybe' }, [], HOME)).toThrow(/true or false/);
    expect(() => loadConfig({}, ['--data-dir', 'relative/dir'], HOME)).toThrow(/absolute path/);
    expect(() => loadConfig({}, ['--allow'], HOME)).toThrow(/needs a value/);
  });
});
