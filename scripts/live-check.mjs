#!/usr/bin/env node
// Checks this server against the Little Snitch on this Mac. Run it yourself:
//
//   npm run build && npm run live-check              read-only checks
//   npm run live-check -- --write                    also adds and removes one test rule
//
// It asks for your approval (Touch ID or the administrator password) the same way
// the server does. The report it prints holds key names, counts and value formats
// only: no app paths, host names, rule notes or preference values, apart from
// fixed vocabulary such as "allow" or "outgoing". It is safe to paste into an issue.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isLosslessNumber } from 'lossless-json';
import { loadConfig } from '../dist/config.js';
import { createContext } from '../dist/context.js';
import { detectEncoding } from '../dist/model/dates.js';
import { isObject, parseModelText } from '../dist/model/json.js';
import { activeProfile } from '../dist/model/profiles.js';
import { parseTraffic, formatTrafficDate } from '../dist/traffic.js';
import { readStatus } from '../dist/tools/status.js';

const argv = process.argv.slice(2);
const doWrite = argv.includes('--write');
const passThrough = argv.filter((arg) => arg !== '--write');
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TEST_HOST = 'lsmcp-live-check.invalid';
const TEST_PROCESS = '/usr/bin/false';

/** Values a rule may show in the report, because they come from a fixed list and name nothing personal. */
const VOCABULARY_KEYS = ['action', 'direction', 'priority', 'origin', 'remote', 'protocol'];

const typeOf = (value) =>
  value === null ? 'null' : isLosslessNumber(value) ? 'number' : Array.isArray(value) ? 'list' : isObject(value) ? 'object' : typeof value;
/** Keeps the format of a text and none of its content: letters become "a", digits "9". */
const mask = (text) => String(text).replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 120);

function keyTable(objects) {
  const table = {};
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      const entry = (table[key] ??= { count: 0, types: new Set(), values: new Set(), dates: new Set() });
      entry.count += 1;
      entry.types.add(typeOf(value));
      if (VOCABULARY_KEYS.includes(key) && typeof value === 'string') {
        entry.values.add(value);
      }
      if (/date|lastUsed/i.test(key)) {
        entry.dates.add(detectEncoding(value) ?? 'not a date');
      }
    }
  }
  // One compact line per key: how many objects have it, its types, and where safe its values or date form.
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => [
      key,
      [
        `in ${entry.count}`,
        [...entry.types].sort().join('|'),
        ...(entry.values.size > 0 ? [`values: ${[...entry.values].sort().join(', ')}`] : []),
        ...(entry.dates.size > 0 ? [`date form: ${[...entry.dates].sort().join(', ')}`] : []),
      ].join('; '),
    ]),
  );
}

function modelShape(model) {
  const container = (value) => (Array.isArray(value) ? `list of ${value.length}` : isObject(value) ? `object with ${Object.keys(value).length} keys` : typeOf(value));
  const objectsIn = (value) => (Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []).filter(isObject);
  const groups = objectsIn(model.groups);
  const users = objectsIn(model.users);
  return {
    topLevel: Object.fromEntries(Object.entries(model).map(([key, value]) => [key, container(value)])),
    ruleFields: keyTable(objectsIn(model.rules)),
    groupFields: keyTable(groups),
    groupKinds: [...new Set(groups.map((group) => String(group.kind ?? group.type ?? 'none')))].sort(),
    groupsWithoutName: groups.filter((group) => typeof group.name !== 'string').length,
    profilesContainer: container(model.profiles),
    profileFields: keyTable(objectsIn(model.profiles)),
    userFields: keyTable(users),
    userDefaultKeys: [...new Set(users.flatMap((user) => (isObject(user.defaults) ? Object.keys(user.defaults) : [])))].sort(),
    globalDefaultKeys: isObject(model.globalDefaults) ? Object.keys(model.globalDefaults).sort() : [],
    noProfilePseudoProfileKeys: isObject(model.noProfilePseudoProfile) ? Object.keys(model.noProfilePseudoProfile).sort() : [],
    activeProfileFound: activeProfile(model, process.getuid?.()).known,
  };
}

const section = (title, value) => console.log(`\n## ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
const attempt = async (title, run) => {
  try {
    section(title, await run());
    return true;
  } catch (error) {
    section(`${title}: FAILED`, { kind: error.kind ?? 'internal', message: error.message, remedy: error.remedy });
    return false;
  }
};

async function readChecks() {
  const config = loadConfig(process.env, passThrough, os.homedir());
  const ctx = createContext(config);
  await attempt('Status (no approval needed)', () => readStatus(ctx));
  await attempt('Configuration shape (approval 1)', async () => modelShape(parseModelText(await ctx.cli.exportModel())));
  await attempt('Traffic log format (approval 2)', async () => {
    const now = new Date();
    const text = await ctx.cli.logTraffic(formatTrafficDate(new Date(now.getTime() - 15 * 60_000)), formatTrafficDate(now));
    const lines = text.split('\n');
    return { header: lines[0] ?? '', rowsParsed: parseTraffic(text).length, firstRowFormat: mask(lines[1] ?? ''), bytes: text.length };
  });
  await attempt('Preference listing format (approval 3)', async () => {
    const text = await ctx.cli.listPreferences('all');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return { lines: lines.length, keys: lines.flatMap((line) => /^\s*([A-Za-z0-9_.-]+) = /.exec(line)?.[1] ?? []), firstLineFormat: mask(lines[0] ?? '') };
  });
}

async function writeCheck() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, ...passThrough, '--allow', 'rules'], stderr: 'inherit' });
  const client = new Client({ name: 'live-check', version: '1' });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const data = JSON.parse(result.content[0]?.text ?? '{}');
    if (result.isError === true) {
      throw Object.assign(new Error(data.error?.message ?? 'tool failed'), data.error ?? {});
    }
    return data;
  };
  const find = async () => (await call('list_rules', { remote: TEST_HOST })).rules;
  try {
    const leftovers = await find();
    if (leftovers.length > 0) {
      section('Write check', `A test rule from an earlier run is still there (ref ${leftovers[0].ref}). Removing it first.`);
      await call('remove_rule', { ref: leftovers[0].ref });
    }
    const spec = { action: 'deny', process: TEST_PROCESS, remote_hosts: [TEST_HOST], notes: 'Test rule of little-snitch-mcp-server live-check. Safe to delete.' };
    const added = await call('add_rule', spec);
    section('Write check: add (approval)', { applied: added.applied, approvedThrough: added.approvedThrough, ruleFieldsReadBack: Object.keys(added.rule ?? {}).sort(), backupSaved: typeof added.backup === 'string' });
    const present = await find();
    section('Write check: rule present after adding', present.length === 1);
    const removed = await call('remove_rule', { ref: present[0].ref });
    section('Write check: remove (approval)', { applied: removed.applied });
    section('Write check: rule gone after removing', (await find()).length === 0);
    section('Write check result', 'PASSED: a rule was added, read back, removed, and confirmed gone. Backups of each step are in the data folder.');
  } catch (error) {
    section('Write check: FAILED', { kind: error.kind ?? 'internal', message: error.message, remedy: error.remedy, details: error.details });
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

console.log(`# little-snitch-mcp-server live check (${path.basename(ENTRY)}, ${new Date().toISOString().slice(0, 10)})`);
console.log(doWrite ? `Read checks, then one test rule (deny ${TEST_PROCESS} to ${TEST_HOST}) is added and removed.` : 'Read-only: nothing in Little Snitch is changed.');
await readChecks();
if (doWrite) {
  await writeCheck();
}
