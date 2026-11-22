import path from 'node:path';

export const DEFAULT_CLI_PATH = '/Applications/Little Snitch.app/Contents/Components/littlesnitch';

export const CAPABILITIES = ['switches', 'rules', 'restore'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ELEVATION_MODES = ['auto', 'sudo', 'dialog', 'none'] as const;
export type ElevationMode = (typeof ELEVATION_MODES)[number];

export interface Config {
  readonly cliPath: string;
  /** False when the path was overridden; an overridden binary is never run as root unless it passes the same checks. */
  readonly cliPathIsDefault: boolean;
  readonly elevation: ElevationMode;
  readonly allow: ReadonlySet<Capability>;
  /** When true, a change does not force a fresh Touch ID or password approval. */
  readonly unattendedWrites: boolean;
  readonly dataDir: string;
  readonly modelCacheMs: number;
  /** Time allowed for a command that may wait on a person at an approval prompt. */
  readonly interactiveTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

interface RawOptions {
  readonly allow?: string;
  readonly elevation?: string;
  readonly unattendedWrites?: string;
  readonly cliPath?: string;
  readonly dataDir?: string;
}

const FLAG_NAMES: Readonly<Record<string, keyof RawOptions>> = {
  '--allow': 'allow',
  '--elevation': 'elevation',
  '--unattended-writes': 'unattendedWrites',
  '--cli-path': 'cliPath',
  '--data-dir': 'dataDir',
};

function parseArgv(argv: readonly string[]): RawOptions {
  const entries: Array<[keyof RawOptions, string]> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = FLAG_NAMES[flag];
    if (key === undefined) {
      throw new ConfigError(`Unknown option "${arg}". Run with --help for the list.`);
    }
    if (key === 'unattendedWrites') {
      entries.push([key, eq === -1 ? 'true' : arg.slice(eq + 1)]);
      continue;
    }
    if (eq !== -1) {
      entries.push([key, arg.slice(eq + 1)]);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ConfigError(`Option "${flag}" needs a value.`);
    }
    entries.push([key, next]);
    i += 1;
  }
  return Object.fromEntries(entries) as RawOptions;
}

function parseAllow(value: string | undefined): ReadonlySet<Capability> {
  if (value === undefined || value.trim() === '' || value.trim() === 'none') {
    return new Set();
  }
  const names = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (names.includes('all')) {
    return new Set(CAPABILITIES);
  }
  const unknown = names.filter((name) => !(CAPABILITIES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown capability "${unknown.join('", "')}". Use a comma-separated list of: ${CAPABILITIES.join(', ')}, or "all".`,
    );
  }
  return new Set(names as Capability[]);
}

function parseElevation(value: string | undefined): ElevationMode {
  if (value === undefined || value.trim() === '') {
    return 'auto';
  }
  const mode = value.trim();
  if (!(ELEVATION_MODES as readonly string[]).includes(mode)) {
    throw new ConfigError(`Unknown elevation "${mode}". Use one of: ${ELEVATION_MODES.join(', ')}.`);
  }
  return mode as ElevationMode;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new ConfigError(`${name} must be true or false, not "${value}".`);
}

function absolutePath(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path, not "${value}".`);
  }
  return path.normalize(value);
}

/**
 * Reads settings from command-line flags first, then environment variables.
 * Anything it does not understand stops the server: a firewall controller
 * must not start with a setting it guessed.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, argv: readonly string[], homeDir: string): Config {
  const flags = parseArgv(argv);
  const cliPathRaw = flags.cliPath ?? env['LITTLE_SNITCH_MCP_CLI_PATH'];
  const dataDirRaw = flags.dataDir ?? env['LITTLE_SNITCH_MCP_DATA_DIR'];
  const cliPath = cliPathRaw === undefined || cliPathRaw === '' ? DEFAULT_CLI_PATH : absolutePath('The CLI path', cliPathRaw);
  const dataDir =
    dataDirRaw === undefined || dataDirRaw === ''
      ? path.join(homeDir, 'Library', 'Application Support', 'little-snitch-mcp-server')
      : absolutePath('The data folder', dataDirRaw);

  return Object.freeze({
    cliPath,
    cliPathIsDefault: cliPath === DEFAULT_CLI_PATH,
    elevation: parseElevation(flags.elevation ?? env['LITTLE_SNITCH_MCP_ELEVATION']),
    allow: parseAllow(flags.allow ?? env['LITTLE_SNITCH_MCP_ALLOW']),
    unattendedWrites: parseBoolean(
      'Unattended writes',
      flags.unattendedWrites ?? env['LITTLE_SNITCH_MCP_UNATTENDED_WRITES'],
    ),
    dataDir,
    modelCacheMs: 15_000,
    interactiveTimeoutMs: 5 * 60_000,
    commandTimeoutMs: 60_000,
  });
}

export const HELP_TEXT = `little-snitch-mcp-server: an MCP server for the Little Snitch firewall (macOS).

It speaks MCP over stdio; an MCP client such as Claude Desktop starts it.

Options (each also has an environment variable):
  --allow <list>          What the assistant may change. Comma-separated list of
                          switches (profiles, rule groups), rules (add, edit, remove),
                          restore (restore a backup this server made), or "all".
                          Default: nothing, the server only reads.
                          LITTLE_SNITCH_MCP_ALLOW
  --elevation <mode>      How root access is obtained: auto (default), sudo, dialog, none.
                          LITTLE_SNITCH_MCP_ELEVATION
  --unattended-writes     Do not force a fresh Touch ID or password approval for
                          each change. LITTLE_SNITCH_MCP_UNATTENDED_WRITES
  --cli-path <path>       Path of the littlesnitch tool. LITTLE_SNITCH_MCP_CLI_PATH
  --data-dir <path>       Where backups and the change log are kept.
                          LITTLE_SNITCH_MCP_DATA_DIR
  --help, --version
`;
