#!/usr/bin/env node
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, HELP_TEXT, loadConfig } from './config.js';
import { createContext } from './context.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new ConfigError('Little Snitch runs on macOS only, so this server does too.');
  }
  const config = loadConfig(process.env, argv, os.homedir());
  const server = createServer(createContext(config));
  // stdout carries the MCP protocol, so anything for a person goes to stderr.
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION}: root access "${config.elevation}", changes allowed: ${config.allow.size === 0 ? 'none (read-only)' : [...config.allow].sort().join(', ')}\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
