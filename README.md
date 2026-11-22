# little-snitch-mcp-server

An MCP server for the [Little Snitch](https://obdev.at/littlesnitch) firewall on macOS. With it, an assistant such as Claude can read your firewall rules and traffic history. If you allow it, the assistant can also switch profiles and rule groups, and add, change or remove rules.

The server works through `littlesnitch`, the command-line tool inside the Little Snitch app. It opens no network connections of its own.

This is an unofficial project. It is not affiliated with Objective Development, and "Little Snitch" is their trademark.

## What you can ask

- "What did Slack connect to in the last hour?"
- "What was blocked today, and for which apps?"
- "Which of my rules have not been used for 90 days?"
- "Do I have a rule that lets curl reach any server?"
- "Switch to my Work profile."
- "Block telemetry.example.com for every app." (needs `--allow rules`)

## What is tested and what is not

Read this before you rely on the server. Little Snitch's tool needs root and a setting that is off by default, so part of the server could only be tested against a simulator of that tool.

| Part | How it was checked |
|---|---|
| Finding the tool, reading its version, checking its code signature | On Little Snitch 6.5, macOS 26.6 |
| Detecting that "Allow access via Terminal" is off | On Little Snitch 6.5 |
| Reading Little Snitch's own log (`get_log`) | On Little Snitch 6.5 |
| Error messages when root access is not set up | On Little Snitch 6.5 |
| Running several commands under one administrator dialog | With macOS `osascript`, without the administrator step |
| Rules, groups, profiles, traffic, preferences, backups | Against the simulator in `tests/fixtures/fake-littlesnitch.mjs` |
| Adding, changing and removing rules, with rollback | Against the simulator |
| Touch ID for sudo | Not run. The command lines are tested, the prompt is not |

The simulator follows Objective Development's documentation and the configuration format that the [torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) project recorded from Little Snitch 6.3.3. Where your Little Snitch differs, the server reports what it could not read. It does not guess.

You can close this gap on your own Mac in two minutes. See [Check it on your Mac](#check-it-on-your-mac).

## Requirements

- macOS with Little Snitch 6. The server was built against version 6.5.
- Node.js 20 or newer.
- An administrator account on the Mac.
- In Little Snitch, Settings > Security > "Allow access via Terminal" switched on. Little Snitch keeps this off by default, because its command-line tool can change the firewall. Switch it on only if you want to use this server.

## Install

```bash
git clone https://github.com/Orhan-Said/little-snitch-mcp-server.git
cd little-snitch-mcp-server
npm install
npm run build
```

Then tell your MCP client to start `dist/index.js`.

Claude Desktop, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "little-snitch": {
      "command": "node",
      "args": ["/absolute/path/to/little-snitch-mcp-server/dist/index.js"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add little-snitch -- node /absolute/path/to/little-snitch-mcp-server/dist/index.js
```

Started this way, the server only reads. Ask the assistant to "check the Little Snitch status". The `get_status` tool lists what is still missing on your Mac.

## Root access

Almost every `littlesnitch` command must run as root. An MCP server has no terminal, so `sudo` cannot ask it for a password. The server has two ways to get your approval, and macOS shows both prompts itself. The server never sees your password.

1. Touch ID for sudo. If you set it up, the server runs `sudo`, and macOS asks for your fingerprint.
2. The macOS administrator dialog. Without Touch ID for sudo, the server asks macOS to show its standard password dialog, with a line that says what the server wants to do. This needs no setup. You type your password for each read and each change.

[docs/root-access.md](docs/root-access.md) has the setup steps for Touch ID, the `--elevation` option, and the reason this project does not suggest a password-free `sudoers` rule.

## Allowing changes

By default the server offers reading tools only. The tools that change something do not exist for the assistant until you name them at startup with `--allow`:

| Value | What the assistant may do |
|---|---|
| `switches` | Activate a profile or deactivate all profiles. Switch a rule group or blocklist on or off. |
| `rules` | Add a rule. Change a rule's action, priority or notes. Remove a rule. |
| `restore` | Replace the whole configuration with a backup that this server saved earlier. |
| `all` | All of the above. |

For example, in the Claude Desktop config:

```json
"args": ["/absolute/path/to/little-snitch-mcp-server/dist/index.js", "--allow", "switches,rules"]
```

Each change needs a fresh approval from you at the Mac, by Touch ID or password, even if you approved a read a moment earlier. `--unattended-writes` removes that rule, so an approval from the last few minutes also covers changes. Leave it off unless you know why you need it.

## Tools

Reading tools, always available:

| Tool | What it does |
|---|---|
| `get_status` | Says whether Little Snitch is reachable, what is allowed, and what you still have to set up. Never shows a prompt. |
| `list_rules` | Lists rules with filters by process, remote, action, group, text and days unused. |
| `list_rule_groups` | Lists rule groups and blocklists and whether each is on. |
| `list_profiles` | Lists profiles and the active one, when the configuration names it. |
| `get_traffic` | Summarizes traffic history by app and host: connections, denied connections, bytes. |
| `get_preferences` | Lists preference keys and values. Hides values whose key looks like a password, key or licence. |
| `get_log` | Reads Little Snitch's own log messages. Needs no root. |
| `list_backups` | Lists the backups this server saved. |
| `create_backup` | Saves the whole configuration to a private file on your Mac. |

Tools that change something, each behind `--allow`:

| Tool | Needs | What it does |
|---|---|---|
| `set_active_profile` | `switches` | Activates a profile by its exact name, or deactivates all profiles. |
| `set_rule_group_enabled` | `switches` | Switches a rule group or blocklist on or off. |
| `add_rule` | `rules` | Adds an allow or deny rule for a process and a remote. |
| `update_rule` | `rules` | Changes the action, priority or notes of one rule. |
| `remove_rule` | `rules` | Removes one rule. |
| `restore_backup` | `restore` | Replaces the whole configuration with a saved backup. |

`add_rule`, `update_rule`, `remove_rule` and `restore_backup` take `dry_run: true`, which shows what would happen and changes nothing.

## How a rule change works

Little Snitch has no command to edit one rule. Its documented route for automation is to export the whole configuration, change it and restore it. The server does that in six steps:

1. It reads the configuration.
2. It saves that configuration as a backup in its data folder.
3. It writes the changed configuration and asks Little Snitch to restore it. This is the step you approve.
4. It reads the configuration back.
5. It checks that every other rule is still there and that the requested change took effect.
6. If a rule got lost or the new rule came back with a different meaning, it restores the backup and reports the failure.

The check covers the rule list, the on and off state of rule groups, and the set of profiles. It does not compare preferences. Fields that Little Snitch updates on its own, such as a rule's last use, do not count as differences. Numbers in the configuration go back exactly as they came, so a value the server does not understand survives the round trip.

## Safety

An assistant that can change a firewall deserves suspicion. The server takes these measures:

- It starts read-only. A tool you did not allow is not offered to the assistant at all.
- macOS asks you to approve each change, outside the assistant's reach. A web page or document that tricks the assistant cannot answer that prompt.
- Before it runs the tool as root, the server checks that the file is owned by root, that nobody else can write to it, and that Objective Development signed it (team `MLZF7K7B5R`).
- It passes arguments to the tool as a list, with no shell in between. The administrator dialog is the one place that needs a shell string. There, the server quotes every word and hands the string to AppleScript as an argument.
- It refuses a rule for any process and any remote, which would switch the firewall off or cut the Mac off from the network.
- It refuses to change or remove protected rules and factory rules.
- It never matches names loosely. A misspelled profile or group name is an error, so a typo cannot switch a different one.
- It keeps backups and a change log (`changes.log`) in a folder only your macOS user can read.

The server tells the assistant that process paths, host names and rule notes are data, not instructions. That is advice to a language model, not a guarantee. The approval prompt and the `--allow` list are the guarantees.

[SECURITY.md](SECURITY.md) lists what the server does not protect against.

## Limits

- Rule lists and traffic summaries become part of your conversation, so your AI provider receives them. Do not use the server if that is not acceptable.
- A rule change replaces the whole configuration. A change you make in Little Snitch during those seconds can be lost, for example a rule you create by answering a connection alert. Finish the approval before you go back to Little Snitch.
- New rules apply in all profiles. The server cannot put a rule into one profile or create a disabled rule, because the fields for that are not confirmed yet.
- Built-in rule groups have no name in the configuration. The server knows the English names of two of them ("macOS Services", "iCloud Services"). It shows other built-in groups but cannot switch them.
- The server cannot answer connection alerts, create profiles, subscribe to blocklists, change preferences or capture packets.
- Little Snitch 5 and older are untested.

## Check it on your Mac

After `npm run build`:

```bash
npm run live-check
```

This runs the read-only parts against your Little Snitch and asks for your approval up to three times. It prints key names, counts and value formats only, with no app paths, host names or rule contents, so you can paste the report into an issue.

```bash
npm run live-check -- --write
```

This also adds one deny rule for `/usr/bin/false` to `lsmcp-live-check.invalid`, reads it back and removes it again. It is the quickest way to learn whether rule editing works with your version of Little Snitch.

If either run fails, please open an issue with the report.

## Options

| Option | Environment variable | Meaning |
|---|---|---|
| `--allow <list>` | `LITTLE_SNITCH_MCP_ALLOW` | Changes the assistant may make. Default: none. |
| `--elevation <mode>` | `LITTLE_SNITCH_MCP_ELEVATION` | `auto` (default), `sudo`, `dialog` or `none`. See [docs/root-access.md](docs/root-access.md). |
| `--unattended-writes` | `LITTLE_SNITCH_MCP_UNATTENDED_WRITES` | Do not force a fresh approval for each change. |
| `--cli-path <path>` | `LITTLE_SNITCH_MCP_CLI_PATH` | Where the `littlesnitch` tool is. Default: inside `/Applications/Little Snitch.app`. |
| `--data-dir <path>` | `LITTLE_SNITCH_MCP_DATA_DIR` | Where backups and the change log go. Default: `~/Library/Application Support/little-snitch-mcp-server`. |

A flag wins over its environment variable. The server stops at startup if it does not understand a setting.

## Development

```bash
npm test               # 234 tests, about 20 seconds
npm run typecheck
npm run test:coverage
```

The tests never touch a real Little Snitch. `tests/fixtures/fake-littlesnitch.mjs` stands in for the tool and can misbehave on request: it can drop a rule, flip an action or ignore a restore, so that the rollback paths run. Two tests look at the real tool's ownership and signature when Little Snitch is installed, and skip otherwise.

[docs/design.md](docs/design.md) explains the decisions behind the server.

## Related work

[torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) is an earlier MCP server for Little Snitch, written in Rust. Its design notes recorded how Little Snitch 6.3.3 writes its configuration, which this project's test fixtures follow. No code was copied. This project exists because that one reports errors on Little Snitch 6.5 (its issues 199 and 201) and had no commit since April 2026 when this one started.

## License

MIT. See [LICENSE](LICENSE).
