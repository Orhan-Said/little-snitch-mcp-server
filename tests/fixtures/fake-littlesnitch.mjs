// A stand-in for Objective Development's `littlesnitch` command-line tool, for tests.
//
// It keeps its "firewall" in a folder: model.json (the configuration), settings.json
// (how it should behave) and calls.jsonl (every invocation, for assertions).
// Messages and exit codes marked OBSERVED were seen on Little Snitch 6.5; the rest
// are placeholders, because the real output is not documented and could not be seen
// without root.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'lossless-json';

const [stateDir, ...args] = process.argv.slice(2);
const file = (name) => path.join(stateDir, name);
const settings = JSON.parse(readFileSync(file('settings.json'), 'utf8'));
const saveSettings = () => writeFileSync(file('settings.json'), JSON.stringify(settings));
const readModel = () => parse(readFileSync(file('model.json'), 'utf8'));
const writeModel = (model) => writeFileSync(file('model.json'), stringify(model));

appendFileSync(file('calls.jsonl'), `${JSON.stringify(args)}\n`);

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

/** What a profile or rule group switch does besides the switch itself, when a test asks for it. */
const applySwitch = (model) => {
  const sideEffect = (settings.switchSideEffects ?? []).shift() ?? 'none';
  settings.exportFailures = settings.failExportsAfterSwitch ?? 0;
  settings.failExportsAfterSwitch = 0;
  saveSettings();
  if (settings.switchesDoNothing === true) {
    return;
  }
  if (sideEffect === 'drop-first-rule') {
    model.rules = model.rules.slice(1);
  }
  if (sideEffect === 'switch-other-group') {
    model.groups.aaaaad = { ...model.groups.aaaaad, isActive: !model.groups.aaaaad.isActive };
  }
  if (sideEffect === 'flip-preference') {
    model.globalDefaults = { ...model.globalDefaults, allowCommandLineAccess: false };
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
    const entry = Object.values(model.groups).find((group) => (group.name ?? BUILTIN_NAMES[group.kind]) === rest[1]);
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
