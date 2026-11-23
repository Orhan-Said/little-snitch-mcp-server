// A stand-in for Objective Development's `littlesnitch` command-line tool, for tests.
//
// It keeps its "firewall" in a folder: model.json (the configuration), settings.json
// (how it should behave) and calls.jsonl (every invocation, for assertions).
// Messages and exit codes marked OBSERVED were seen on Little Snitch 6.5; the rest
// are placeholders, because the real output is not documented and could not be seen
// without root.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'lossless-json';

const [stateDir, ...rawArgs] = process.argv.slice(2);
// "-u <user>" before the command names the user the tool acts for. Without it, a tool run as root acts for root.
const hasUser = rawArgs[0] === '-u' || rawArgs[0] === '--user';
const actingUser = hasUser ? Number(rawArgs[1]) : 0;
const args = hasUser ? rawArgs.slice(2) : rawArgs;
const file = (name) => path.join(stateDir, name);
const settings = JSON.parse(readFileSync(file('settings.json'), 'utf8'));
const saveSettings = () => writeFileSync(file('settings.json'), JSON.stringify(settings));
const readModel = () => parse(readFileSync(file('model.json'), 'utf8'));
const writeModel = (model) => writeFileSync(file('model.json'), stringify(model));

// The second half of a slow restore is the same invocation, so it is recorded once.
const late = process.env.LSMCP_FAKE_LATE === '1';
if (!late) {
  appendFileSync(file('calls.jsonl'), `${JSON.stringify(args)}\n`);
  appendFileSync(file('raw-calls.jsonl'), `${JSON.stringify(rawArgs)}\n`);
}

const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const [command, ...rest] = args;

if (command === '--version') {
  process.stdout.write('Version 6.5\n'); // OBSERVED
  process.exit(0);
}
if (command === 'log') {
  process.stdout.write(readFileSync(file('log.json'), 'utf8'));
  process.exit(0);
}
const NOT_AUTHORIZED = 'Error: command line tool is not authorized to make changes.\nPlease enable access in Little Snitch.app > Preferences > Security.'; // OBSERVED
if (command === 'restrictions') {
  if (!settings.terminalAccess) {
    process.stdout.write(`${NOT_AUTHORIZED}\n`);
    process.exit(1); // OBSERVED: exit 1 without root when access is off
  }
  process.stdout.write('No restrictions.\n');
  process.exit(0);
}
if (!settings.root) {
  process.stdout.write('littlesnitch must be run as root!\n'); // OBSERVED, exit 14
  process.exit(14);
}
if (!settings.terminalAccess) {
  fail(1, NOT_AUTHORIZED);
}

const BUILTIN_NAMES = { builtinMacOSServices: 'macOS Services', builtinICloudServices: 'iCloud Services' };

/**
 * Stores the result of a profile or rule group switch, with whatever a test asked it to do besides.
 * A fake told that switches do nothing leaves the switch out and still does the rest.
 */
const applySwitch = (switched) => {
  const sideEffect = (settings.switchSideEffects ?? []).shift() ?? 'none';
  settings.exportFailures = settings.failExportsAfterSwitch ?? 0;
  settings.failExportsAfterSwitch = 0;
  saveSettings();
  const model = settings.switchesDoNothing === true ? readModel() : switched;
  if (sideEffect === 'drop-first-rule') {
    model.rules = model.rules.slice(1);
  }
  if (sideEffect === 'switch-other-group') {
    model.groups.aaaaad = { ...model.groups.aaaaad, isActive: !model.groups.aaaaad.isActive };
  }
  if (sideEffect === 'flip-preference') {
    model.globalDefaults = { ...model.globalDefaults, allowCommandLineAccess: false };
  }
  if (sideEffect === 'activate-p2') {
    model.users[0].defaults.activeProfile = 'p2';
  }
  writeModel(model);
};

switch (command) {
  case 'export-model': {
    if ((settings.exportFailures ?? 0) > 0) {
      settings.exportFailures -= 1;
      saveSettings();
      fail(1, 'Error: could not export the model.');
    }
    process.stdout.write(readFileSync(file('model.json'), 'utf8'));
    break;
  }
  case 'restore-model': {
    // A slow restore: the work is handed to a process of its own, which goes on after this one was killed for
    // taking too long, the way a command run as root goes on after the dialog that started it is gone.
    if ((settings.restoreTakesMs ?? 0) > 0 && !late) {
      const wait = settings.restoreTakesMs;
      settings.restoreTakesMs = 0;
      saveSettings();
      writeFileSync(file('restore-at-work'), '');
      // The script is fixed text. The marker file and the wait reach it through the environment, so nothing is
      // pasted into code.
      const later =
        "setTimeout(() => { require('node:child_process').spawnSync(process.execPath, process.argv.slice(1), { env: { ...process.env, LSMCP_FAKE_LATE: '1' } }); require('node:fs').rmSync(process.env.LSMCP_FAKE_MARKER, { force: true }); }, Number(process.env.LSMCP_FAKE_WAIT_MS));";
      spawn(process.execPath, ['-e', later, fileURLToPath(import.meta.url), stateDir, ...rawArgs], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, LSMCP_FAKE_MARKER: file('restore-at-work'), LSMCP_FAKE_WAIT_MS: String(Number(wait)) },
      }).unref();
      setInterval(() => undefined, 1000);
      await new Promise(() => undefined);
    }
    const input = rest.filter((word) => !word.startsWith('-')).at(-1);
    if (!rest.includes('--preserve-terminal-access') && !rest.includes('-t')) {
      settings.terminalAccess = false;
    }
    const behavior = settings.restoreBehaviors.shift() ?? 'accept';
    // The read-backs that follow this restore can be made to fail a number of times.
    settings.exportFailures = settings.failExportsAfterRestore ?? 0;
    settings.failExportsAfterRestore = 0;
    saveSettings();
    if (behavior === 'reject') {
      fail(1, 'Error: the backup file is not valid.');
    }
    const incoming = parse(readFileSync(input, 'utf8'));
    const current = readModel();
    if (behavior === 'ignore') {
      break;
    }
    if (behavior === 'drop-first-rule') {
      incoming.rules = incoming.rules.slice(1);
    }
    if (behavior === 'flip-new-action') {
      const last = incoming.rules.at(-1);
      incoming.rules = [...incoming.rules.slice(0, -1), { ...last, action: last.action === 'allow' ? 'deny' : 'allow' }];
    }
    const isNew = (index) => index >= current.rules.length;
    if (behavior === 'respell') {
      // Spellings a real Little Snitch may choose for the same rule: a default written out, a protocol as a number, one remote as a list.
      incoming.rules = incoming.rules.map((rule, index) =>
        !isNew(index)
          ? rule
          : {
              ...rule,
              direction: 'outgoing',
              ...(rule.protocol === 'tcp' ? { protocol: '6' } : {}),
              ...(typeof rule['remote-domains'] === 'string' ? { 'remote-domains': [rule['remote-domains']] } : {}),
            },
      );
    }
    if (behavior === 'add-unknown-field') {
      incoming.rules = incoming.rules.map((rule, index) => (isNew(index) ? { ...rule, disabled: true } : rule));
    }
    if (behavior === 'change-uid') {
      incoming.rules = incoming.rules.map((rule, index) => (isNew(index) ? { ...rule, uid: 0 } : rule));
    }
    if (behavior === 'flip-preference') {
      incoming.globalDefaults = { ...incoming.globalDefaults, allowCommandLineAccess: false };
    }
    if (behavior === 'switch-group') {
      incoming.groups.aaaaac = { ...incoming.groups.aaaaac, isActive: true };
    }
    if (behavior === 'add-stray-rule') {
      incoming.rules = [...incoming.rules, { action: 'allow', process: 'any', 'remote-domains': 'stray.example' }];
    }
    // What a real Little Snitch 6.5 did by itself on every restore (seen on 2026-11-23):
    settings.restores = (settings.restores ?? 0) + 1;
    saveSettings();
    // it rebuilt its table of developer names,
    incoming.developerTeamNames = { MLZF7K7B5R: `Objective Development, rebuilt ${settings.restores}` };
    // it rewrote its list of known network extensions,
    incoming.knownNEs = settings.restores % 2 === 1 ? [...(incoming.knownNEs ?? []), 'com.example.vpn'] : (incoming.knownNEs ?? []);
    // it wrote the map position back under keys that start with a small letter,
    incoming.users = incoming.users.map((user) => ({
      ...user,
      defaults: Object.fromEntries(Object.entries(user.defaults ?? {}).map(([key, value]) => [key.startsWith('GeoView') ? `g${key.slice(1)}` : key, value])),
    }));
    // and it added a record for the user it acted for when there was none: root, unless "-u" named someone.
    if (!incoming.users.some((user) => Number(user.uid?.value ?? user.uid) === actingUser)) {
      incoming.users = [...incoming.users, { uid: actingUser, shortName: actingUser === 0 ? 'root' : 'user', fullName: 'Added by restore', defaults: {} }];
    }
    writeModel(incoming);
    break;
  }
  case 'profile': {
    const model = readModel();
    const user = model.users[0];
    if (rest[0] === '--deactivate-all') {
      user.defaults.activeProfile = null;
    } else if (rest[0] === '--activate') {
      const entry = Object.entries(model.profiles).find(([, profile]) => profile.name === rest[1]);
      if (entry === undefined) {
        fail(1, `Profile "${rest[1]}" not found.`);
      }
      user.defaults.activeProfile = entry[0];
    } else {
      fail(64, 'usage: littlesnitch profile [-dh] [-a <profile name>]');
    }
    applySwitch(model);
    break;
  }
  case 'rulegroup': {
    const model = readModel();
    const entry = Object.values(model.groups).find((group) => (group.userProvidedName ?? group.name ?? BUILTIN_NAMES[group.type ?? group.kind]) === rest[1]);
    if (entry === undefined || (rest[0] !== '--enable' && rest[0] !== '--disable')) {
      fail(1, `Rule group or blocklist "${rest[1]}" not found.`); // message recorded by torsday/little-snitch-mcp
    }
    entry.isActive = rest[0] === '--enable';
    applySwitch(model);
    break;
  }
  case 'list-preferences': {
    process.stdout.write(readFileSync(file('preferences.txt'), 'utf8'));
    break;
  }
  case 'log-traffic': {
    process.stdout.write(readFileSync(file('traffic.csv'), 'utf8'));
    break;
  }
  default:
    fail(64, `usage: littlesnitch [-hv] command (unknown command ${command})`);
}
