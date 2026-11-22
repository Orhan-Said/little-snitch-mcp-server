#!/usr/bin/env node
// Checks this server against the Little Snitch on this Mac. Run it yourself:
//
//   npm run build && npm run live-check              read-only checks, one approval
//   npm run live-check -- --write                    also adds and removes one test rule, four more approvals
//
// It asks for your approval (Touch ID or the administrator password) the same way
// the server does. The report it prints holds key names, counts and value formats
// only: no app paths, host names, rule notes or preference values, apart from
// fixed vocabulary such as "allow" or "outgoing", and apart from the one test
// rule it makes itself. It is safe to paste into an issue.
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isLosslessNumber } from 'lossless-json';
import { createBinaryChecker } from '../dist/cli/binary.js';
import { createElevator, touchIdConfigured } from '../dist/cli/elevation.js';
import { execFile } from '../dist/cli/exec.js';
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
const mask = (text) => String(text).replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 160);

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
    ruleEntriesThatAreNotObjects: Array.isArray(model.rules) ? model.rules.filter((entry) => !isObject(entry)).length : 'rules is not a list',
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
const problem = (error) => ({ kind: error.kind ?? 'internal', message: error.message, remedy: error.remedy });

/** The three privileged reads go through one approval. */
async function readChecks() {
  const config = loadConfig(process.env, passThrough, os.homedir());
  const ctx = createContext(config);
  try {
    section('Status (no approval needed)', await readStatus(ctx));
  } catch (error) {
    section('Status: FAILED', problem(error));
  }

  const restrictions = await execFile(config.cliPath, ['restrictions'], { timeoutMs: 15_000 });
  section('The "restrictions" command without root', {
    exit: restrictions.code,
    lines: `${restrictions.stdout}${restrictions.stderr}`.split('\n').filter((line) => line.trim() !== '').length,
    firstLineFormat: mask(`${restrictions.stdout}${restrictions.stderr}`.split('\n')[0] ?? ''),
  });

  const now = new Date();
  const steps = [
    { name: 'export-model', args: ['export-model'] },
    { name: 'list-preferences', args: ['list-preferences'] },
    { name: 'log-traffic', args: ['log-traffic', '--begin-date', formatTrafficDate(new Date(now.getTime() - 15 * 60_000)), '--end-date', formatTrafficDate(now)] },
  ];
  let outputs;
  try {
    if (config.elevation !== 'none') {
      await createBinaryChecker(config.cliPath, execFile).assertTrusted();
    }
    const elevator = createElevator({ exec: execFile, config, touchIdConfigured: () => touchIdConfigured(), randomToken: () => randomBytes(16).toString('hex') });
    const run = await elevator.run(steps.map((step) => ({ args: step.args })), 'Little Snitch MCP live check wants to read your Little Snitch rules, preferences and traffic history.');
    section('How root access was obtained for the reads', run.method);
    outputs = run.steps;
  } catch (error) {
    section('Reading as root: FAILED', problem(error));
    return false;
  }

  const report = (index, title, build) => {
    const output = outputs[index];
    if (output === undefined) {
      section(`${title}: did not run, because an earlier command failed`, '');
      return;
    }
    if (output.code !== 0) {
      section(`${title}: FAILED`, { exit: output.code, messageFormat: mask(`${output.stderr}${output.stdout}`.trim().split('\n')[0] ?? ''), message: `${output.stderr}`.trim().split('\n')[0]?.slice(0, 200) });
      return;
    }
    try {
      section(title, build(output.stdout));
    } catch (error) {
      section(`${title}: could not be read`, { ...problem(error), bytes: output.stdout.length, startFormat: mask(output.stdout.slice(0, 80)) });
    }
  };
  report(0, 'Configuration shape', (text) => ({ bytes: text.length, ...modelShape(parseModelText(text)) }));
  report(1, 'Preference listing format', (text) => {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return { lines: lines.length, keys: lines.flatMap((line) => /^\s*([A-Za-z0-9_.-]+) = /.exec(line)?.[1] ?? []), firstLineFormat: mask(lines[0] ?? '') };
  });
  report(2, 'Traffic log format', (text) => {
    const lines = text.split('\n');
    return { header: lines[0] ?? '', rowsParsed: parseTraffic(text).length, firstRowFormat: mask(lines[1] ?? ''), bytes: text.length };
  });
  return true;
}

/** Only what concerns the test rule is printed in full. Everything else from a failure is reduced to counts and section names. */
function safeDetails(details) {
  if (details === undefined || details === null) {
    return undefined;
  }
  const aboutTestRule = (rule) => JSON.stringify(rule ?? {}).includes(TEST_HOST);
  const rules = (list) => (Array.isArray(list) ? { count: list.length, aboutTheTestRule: list.filter(aboutTestRule) } : undefined);
  return {
    rolledBack: details.rolledBack,
    configurationAsBefore: details.configurationAsBefore,
    cause: details.cause,
    changedSections: details.changedSections,
    missing: rules(details.missing),
    unexpected: rules(details.unexpected),
    notApplied: rules(details.notApplied),
    notRemoved: rules(details.notRemoved),
    afterUndo: details.afterUndo === undefined ? undefined : { changedSections: details.afterUndo.changedSections, missing: rules(details.afterUndo.missing), unexpected: rules(details.afterUndo.unexpected) },
  };
}

async function writeCheck() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, ...passThrough, '--allow', 'rules'], stderr: 'inherit' });
  const client = new Client({ name: 'live-check', version: '1' });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60_000 });
    const data = JSON.parse(result.content[0]?.text ?? '{}');
    if (result.isError === true) {
      throw Object.assign(new Error(data.error?.message ?? 'tool failed'), data.error ?? {});
    }
    return data;
  };
  const spec = { action: 'deny', process: TEST_PROCESS, remote_hosts: [TEST_HOST], notes: 'Test rule of little-snitch-mcp-server live-check. Safe to delete.' };
  try {
    let added;
    try {
      added = await call('add_rule', spec);
    } catch (error) {
      const leftover = /\(ref (r[0-9a-f]{12})\)/.exec(error.message ?? '');
      if (leftover === null) {
        throw error;
      }
      section('Write check', `A test rule from an earlier run is still there (${leftover[1]}). Removing it and stopping; run the check again afterwards.`);
      await call('remove_rule', { ref: leftover[1] });
      return;
    }
    section('Write check: add (two approvals: one to read, one to change)', {
      applied: added.applied,
      approvedThrough: added.approvedThrough,
      ruleReadBack: added.rule,
      backupSaved: typeof added.backup === 'string',
      warnings: added.warnings,
    });
    const removed = await call('remove_rule', { ref: added.rule.ref });
    section('Write check: remove (two approvals)', { applied: removed.applied, warnings: removed.warnings });
    const left = (await call('list_rules', { remote: TEST_HOST })).rules.length;
    section('Write check: test rules left afterwards', left);
    section('Write check result', left === 0 ? 'PASSED: a rule was added, checked against the whole configuration, removed, and confirmed gone.' : 'FAILED: the test rule is still there.');
  } catch (error) {
    section('Write check: FAILED', { kind: error.kind ?? 'internal', message: error.message, remedy: error.remedy, details: safeDetails(error.details) });
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

console.log(`# little-snitch-mcp-server live check (${path.basename(ENTRY)}, ${new Date().toISOString().slice(0, 10)})`);
console.log(
  doWrite
    ? `Read checks (one approval), then one test rule (deny ${TEST_PROCESS} to ${TEST_HOST}) is added and removed (four approvals, or two with Touch ID for sudo).`
    : 'Read-only: nothing in Little Snitch is changed. One approval.',
);
const readsWorked = await readChecks();
if (doWrite && readsWorked) {
  await writeCheck();
} else if (doWrite) {
  section('Write check', 'Skipped, because the read checks did not get through.');
}
