import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Capability } from '../../src/config.js';
import { createContext } from '../../src/context.js';
import { parseModelText, type JsonObject } from '../../src/model/json.js';
import { createServer } from '../../src/server.js';
import { sampleModelText } from '../fixtures/model.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-littlesnitch.mjs', import.meta.url));

export const NOW = new Date('2026-11-22T16:00:00Z');

export const TRAFFIC_CSV = [
  'date,direction,uid,ipAddress,remoteHostname,protocol,port,connectCount,denyCount,byteCountIn,byteCountOut,connectingExecutable,parentAppExecutable',
  '2026-11-22 19:10:00,out,501,203.0.113.10,api.slack.example,6,443,3,0,12000,3400,/Applications/Slack.app/Contents/MacOS/Slack,',
  '2026-11-22 19:20:00,out,501,203.0.113.11,telemetry.slack.example,6,443,0,5,0,0,/Applications/Slack.app/Contents/MacOS/Slack,',
  '2026-11-22 19:30:00,out,501,198.51.100.7,"cdn.example, inc",6,443,1,0,900000,1200,/Applications/Safari.app/Contents/Frameworks/Helper,/Applications/Safari.app/Contents/MacOS/Safari',
  '2026-11-22 19:40:00,out,501,203.0.113.10,api.slack.example,6,443,2,0,8000,600,/Applications/Slack.app/Contents/MacOS/Slack,',
  '2026-11-22 19:50:00,in,501,192.168.1.20,,17,5353,4,0,300,0,/usr/sbin/mDNSResponder,',
  '',
].join('\n');

export const PREFERENCES_TEXT = [
  '    activeSilentMode = 0',
  '    allowCommandLineAccess = true',
  '    licenseKey = ABCD-1234-SECRET',
  '    dontShowDenyConsequencesAgain = (',
  '        "com.example.app"',
  '    )',
  '',
].join('\n');

export const LOG_JSON = JSON.stringify([
  { timestamp: '2026-11-22 19:58:00.000000+0400', processImagePath: '/Applications/Little Snitch.app/Contents/Components/Little Snitch Agent.app/Contents/MacOS/Little Snitch Agent', messageType: 'Default', eventMessage: '7303: Agent started' },
  { timestamp: '2026-11-22 19:59:00.000000+0400', processImagePath: '/Applications/Little Snitch.app/Contents/Components/littlesnitch', messageType: 'Error', eventMessage: '7303: Rule import failed' },
]);

export interface HarnessOptions {
  readonly allow?: readonly Capability[] | 'all';
  readonly terminalAccess?: boolean;
  readonly root?: boolean;
  /** How the fake answers each restore-model call, in order; later calls are accepted. */
  readonly restoreBehaviors?: readonly string[];
  readonly switchesDoNothing?: boolean;
  readonly modelText?: string;
  /** How many export-model calls fail after the first restore-model. */
  readonly failExportsAfterRestore?: number;
  /** How many export-model calls fail after the first profile or rule group switch. */
  readonly failExportsAfterSwitch?: number;
  /** What each profile or rule group switch does besides the switch, in order. */
  readonly switchSideEffects?: readonly string[];
  /** How long the fake takes over its first restore-model, in milliseconds: it hands the work to a process that outlives it. */
  readonly restoreTakesMs?: number;
  /** Time the server gives one command, and the time it waits after one that did not end. */
  readonly commandTimeoutMs?: number;
  readonly settleMs?: number;
}

export interface Harness {
  readonly client: Client;
  readonly dataDir: string;
  /** The lock this test's servers share. A real server uses one file for the whole Mac; each test has its own. */
  readonly lockFile: string;
  /** True while the fake's slow restore is still at work. */
  restoreAtWork(): boolean;
  /** The fake firewall's configuration as it is now. */
  model(): JsonObject;
  modelText(): string;
  /** Every invocation of the fake tool, as argument lists, without the "-u <user>" in front. */
  calls(): readonly (readonly string[])[];
  /** Every invocation exactly as it was made. */
  rawCalls(): readonly (readonly string[])[];
  /** Calls a tool and returns its parsed result together with the error flag. */
  call(name: string, args?: Record<string, unknown>): Promise<{ readonly isError: boolean; readonly data: any }>;
  close(): Promise<void>;
}

/** Writes a fake `littlesnitch` into a temporary folder and returns its path and state folder. */
export function installFake(root: string, options: HarnessOptions = {}): { readonly cliPath: string; readonly stateDir: string } {
  const stateDir = path.join(root, 'state');
  const cliPath = path.join(root, 'littlesnitch');
  mkdirSync(stateDir, { recursive: true });
  const write = (name: string, text: string): void => writeFileSync(path.join(stateDir, name), text);
  write('model.json', options.modelText ?? sampleModelText());
  write(
    'settings.json',
    JSON.stringify({
      terminalAccess: options.terminalAccess ?? true,
      root: options.root ?? true,
      restoreBehaviors: options.restoreBehaviors ?? [],
      switchesDoNothing: options.switchesDoNothing ?? false,
      failExportsAfterRestore: options.failExportsAfterRestore ?? 0,
      failExportsAfterSwitch: options.failExportsAfterSwitch ?? 0,
      switchSideEffects: options.switchSideEffects ?? [],
      restoreTakesMs: options.restoreTakesMs ?? 0,
    }),
  );
  write('traffic.csv', TRAFFIC_CSV);
  write('preferences.txt', PREFERENCES_TEXT);
  write('log.json', LOG_JSON);
  write('calls.jsonl', '');
  write('raw-calls.jsonl', '');
  // The server gives its children a fixed PATH, so the wrapper names node by its full path.
  writeFileSync(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${stateDir}" "$@"\n`);
  chmodSync(cliPath, 0o755);
  return { cliPath, stateDir };
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-test-'));
  const { cliPath, stateDir } = installFake(root, options);
  const dataDir = path.join(root, 'data');
  const allow = options.allow === undefined ? [] : options.allow === 'all' ? ['all'] : options.allow;
  const loaded = loadConfig({}, ['--cli-path', cliPath, '--elevation', 'none', '--data-dir', dataDir, '--allow', allow.join(',') || 'none'], root);
  const config = {
    ...loaded,
    lockFile: path.join(root, 'change.lock'),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  };
  // The fake's slow restore says that it is at work with a file, the way the real one shows in the process list.
  const restoreAtWork = (): boolean => existsSync(path.join(stateDir, 'restore-at-work'));
  const server = createServer(createContext(config, { now: () => NOW, uid: 501, commandRunning: async () => restoreAtWork() }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const modelText = (): string => readFileSync(path.join(stateDir, 'model.json'), 'utf8');
  const readCalls = (name: string): string[][] =>
    readFileSync(path.join(stateDir, name), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
  return {
    client,
    dataDir,
    lockFile: config.lockFile,
    restoreAtWork,
    modelText,
    model: () => parseModelText(modelText()),
    calls: () => readCalls('calls.jsonl'),
    rawCalls: () => readCalls('raw-calls.jsonl'),
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.text ?? '';
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // A protocol-level error arrives as plain text.
      }
      return { isError: result.isError === true, data };
    },
    async close() {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
