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
| Detecting whether "Allow access via Terminal" is on or off | On Little Snitch 6.5, in both states |
| Reading Little Snitch's own log (`get_log`) | On Little Snitch 6.5 |
| The administrator dialog with a real password, with three reads under one approval | On Little Snitch 6.5 |
| Reading and parsing a real configuration of several hundred rules, the preference listing and the traffic history | On Little Snitch 6.5. Only key names, counts and formats were recorded. |
| The lock that keeps two changes apart | With macOS `lockf`: twelve takers at once, and a holder that is killed |
| The shell text for a restore, with its checked private copy | With `/bin/sh` and `osascript`, without the administrator step |
| Listing and filtering rules, groups, traffic and preferences | Against the simulator in `tests/fixtures/fake-littlesnitch.mjs`, whose configuration has the shape of that real one |
| Adding, changing and removing rules, switching groups and profiles, with the check afterwards and the undo | Against the simulator |
| Profiles | Against the simulator only. The real configuration had none, so their shape comes from older notes. |
| Touch ID for sudo | Not run |

The simulator follows Objective Development's documentation, the shape of a real Little Snitch 6.5 configuration, and for what that configuration did not contain, the format that the [torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) project recorded from Little Snitch 6.3.3. Where your Little Snitch differs, the server reports what it could not read. It does not guess.

The check after a change is strict, and no change has been made to a real Little Snitch yet. If Little Snitch rewrites something this project does not know about, the server will undo every change and tell you which part differed, down to the name of the preference key. You can find out on your own Mac in two minutes. See [Check it on your Mac](#check-it-on-your-mac).

## Requirements

- macOS with Little Snitch 6. The server was built against version 6.5.
- Node.js 20 or newer.
- An administrator account on the Mac.
- In Little Snitch, open Settings, go to Security, and switch on "Allow access via Terminal" in the group "Other". Little Snitch keeps this off by default, because its command-line tool can change the firewall. Switch it on only if you want to use this server.

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

Almost every `littlesnitch` command must run as root. An MCP server has no terminal, so `sudo` cannot ask it for a password. macOS shows the prompts itself, and the server never sees your password.

For reading, the server tries three ways in this order:

1. `sudo` without a prompt, which works only if your Mac already allows it.
2. Touch ID for sudo, if you set it up. macOS asks for your fingerprint.
3. The macOS administrator dialog, which needs no setup. You type your password.

For a change, the server always uses the administrator dialog. The dialog states the change, for example `Little Snitch MCP wants to ADD a firewall rule: DENY connections to the domains tracker.example for /Applications/Slack.app/Contents/MacOS/Slack.` It is the one prompt the server can rely on: `sudo` asks nobody when a password-free rule matches, and the server cannot see such a rule.

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

Two settings remove the approval for changes. Use them only if that is what you want:

- `--unattended-writes` lets a change run through `sudo` like a read. With a password-free `sudo` rule, or within a few minutes of a Touch ID approval, nobody is asked. It has no effect with `--elevation dialog`, which always shows the dialog.
- `--elevation none` runs the tool directly and never asks anyone. It exists for the tests and works only when the server itself runs as root.

`get_status` says in capital letters when changes need no approval.

## Tools

Reading tools, always available:

| Tool | What it does |
|---|---|
| `get_status` | Says whether Little Snitch is reachable, what is allowed, how changes are approved, and what you still have to set up. Never shows a prompt. |
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
| `set_active_profile` | `switches` | Activates a profile by its exact name, or deactivates all profiles. Answers "accepted" instead of "applied" when it cannot read the result back. |
| `set_rule_group_enabled` | `switches` | Switches a rule group or blocklist on or off, by its exact id or name. Runs nothing when the group is already in that state. |
| `add_rule` | `rules` | Adds an allow or deny rule for a process and a remote. |
| `update_rule` | `rules` | Changes the action, priority or notes of one rule. |
| `remove_rule` | `rules` | Removes one rule. |
| `restore_backup` | `restore` | Replaces the whole configuration with a saved backup. |

`add_rule`, `update_rule`, `remove_rule` and `restore_backup` take `dry_run: true`. A dry run changes nothing and returns what would happen, including the text of the approval prompt.

## How a rule change works

Little Snitch has no command to edit one rule. Its documented route for automation is to export the whole configuration, change it and restore it. The server does that one change at a time. A lock that macOS holds for the server keeps two copies of the server apart: the second one reports that it is busy. The lock frees itself if the server dies.

1. It reads the configuration and saves it as a backup in its data folder.
2. It writes the changed configuration to a file and notes the file's checksum.
3. It asks macOS for the administrator dialog. As root, a small script copies the file into a folder only root can enter, compares the copy with the checksum, and has Little Snitch restore the copy. Another program of yours cannot swap the file after you approved.
4. Under the same approval, it reads the configuration back.
5. It compares the whole configuration with the one it intended. A rule nobody asked for, a field of the new rule that came back different, and any change to preferences, rule groups or profiles count as a difference.
6. If there is a difference, it restores the configuration it read in step 1, compares again, and reports the failure. If that fails too, the error gives you the command to restore the backup by hand, with the checksum the backup file must have.

The comparison ignores three things. One is what Little Snitch updates as traffic flows: a rule's last use and use count. The second is what Little Snitch keeps for itself: its statistics, its list of programs it has seen, and its version markers. The third is five preference keys that hold no policy and change while Little Snitch runs, such as the process id of its open window (`VOLATILE_PREFERENCE_KEYS` in `src/model/verify.ts`). For the rule just written, its dates and a few spellings may also differ, for example `tcp` and `6`.

If the read-back fails, the server reads the configuration again and undoes the change when it differs from before.

A timeout is different. The command that was started may still be running as root, and a second restore on top of it could collide with it. So after a timeout the server starts nothing further. It tells you that it does not know whether the change is in effect, and gives you the command to restore the backup by hand.

Profile and rule group switches follow the same steps, with Little Snitch's own `profile` and `rulegroup` commands in place of the restore. For a rule group the whole configuration must afterwards equal the earlier one with that one group switched. For a profile, no rule may have changed, and the answer lists the other parts that did.

A change log that cannot be written does not fail a change. The result then carries a warning.

## Safety

An assistant that can change a firewall deserves suspicion. The server takes these measures:

- It starts read-only. A tool you did not allow is not offered to the assistant at all.
- macOS asks you to approve each change in the administrator dialog, outside the assistant's reach. A web page or document that tricks the assistant cannot answer that prompt.
- The prompt is built from the rule's fields, with the action and the remote first, then the process, a note if there is one, and the macOS user if the rule belongs to someone else. A long process path keeps its beginning and its end. For a change to a rule, the prompt ends with the rule as it will be.
- A rule whose remote list does not fit into the prompt cannot be added, changed or removed through the server. Paths and notes with invisible characters are refused.
- Before it runs the tool as root, the server checks that the file is owned by root, that nobody else can write to it, and that Objective Development signed it (team `MLZF7K7B5R`).
- It passes arguments to the tool as a list, with no shell in between. The administrator dialog is the one place that needs a shell string. There, the server quotes every word and hands the string to AppleScript as an argument.
- It refuses a rule for any process and any remote, which would switch the firewall off or cut the Mac off from the network.
- It refuses to change or remove protected rules and factory rules.
- It respects Little Snitch's own switches under Settings > Security. With "Allow Rule Editing" off for your user, it changes no rule, rule group or blocklist. With "Allow Profile Switching" off, it switches no profile. The command-line tool itself would not be held back by these.
- It matches profile and group names exactly, including letter case, so a typo cannot switch a different one.
- It keeps backups and a change log (`changes.log`) in a folder only your macOS user can read.

The server tells the assistant that process paths, host names and rule notes are data, not instructions. That is advice to a language model, not a guarantee. The approval prompt and the `--allow` list are the guarantees.

[SECURITY.md](SECURITY.md) lists what the server does not protect against.

## Limits

- Rule lists and traffic summaries become part of your conversation, so your AI provider receives them. Do not use the server if that is not acceptable.
- A rule change replaces the whole configuration. If you change something in Little Snitch during those seconds, for example by answering a connection alert, the check sees a difference and the server restores the backup. Your change is then gone, and the error lists it. Finish the approval before you go back to Little Snitch.
- Where Little Snitch keeps the active profile is not documented. If the server does not find it in the configuration, it cannot confirm a profile switch. It then answers "accepted", lists what else changed, and leaves the check to you.
- The lock is per macOS user. Two different macOS users who change Little Snitch at the same moment are not kept apart.
- New rules apply in all profiles. The server cannot put a rule into one profile or create a disabled rule, because the fields for that are not confirmed yet.
- Built-in rule groups have no name in the configuration. The server knows the English names of two of them ("macOS Services", "iCloud Services"). A group or blocklist you named yourself is found by that name. The server shows other groups but cannot switch them.
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

This also adds one deny rule for `/usr/bin/false` to `lsmcp-live-check.invalid`, reads it back and removes it again. It is the quickest way to learn whether rule editing works with your version of Little Snitch. Make a backup in Little Snitch first, with File > Create Backup. With `--write-only` in place of `--write`, the read checks are left out.

If either run fails, please open an issue with the report.

## Options

| Option | Environment variable | Meaning |
|---|---|---|
| `--allow <list>` | `LITTLE_SNITCH_MCP_ALLOW` | Changes the assistant may make. Default: none. |
| `--elevation <mode>` | `LITTLE_SNITCH_MCP_ELEVATION` | `auto` (default), `sudo`, `dialog` or `none`. See [docs/root-access.md](docs/root-access.md). |
| `--unattended-writes` | `LITTLE_SNITCH_MCP_UNATTENDED_WRITES` | Let changes run through `sudo` without the administrator dialog. No effect with `--elevation dialog`. |
| `--cli-path <path>` | `LITTLE_SNITCH_MCP_CLI_PATH` | Where the `littlesnitch` tool is. Default: inside `/Applications/Little Snitch.app`. |
| `--data-dir <path>` | `LITTLE_SNITCH_MCP_DATA_DIR` | Where backups and the change log go. Default: `~/Library/Application Support/little-snitch-mcp-server`. |

A flag wins over its environment variable. The server stops at startup if it does not understand a setting.

## Development

```bash
npm test               # 310 tests, about 30 seconds
npm run typecheck
npm run test:coverage
```

The tests never touch a real Little Snitch. `tests/fixtures/fake-littlesnitch.mjs` stands in for the tool and can misbehave on request. It can drop a rule, flip an action, add a rule nobody asked for, change a preference, switch the wrong group or fail a read-back, so that the check and the undo run. Two tests look at the real tool's ownership and signature when Little Snitch is installed, and skip otherwise.

[docs/design.md](docs/design.md) explains the decisions behind the server, and what two outside reviews changed.

## Related work

[torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) is an earlier MCP server for Little Snitch, written in Rust. Its design notes recorded how Little Snitch 6.3.3 writes its configuration, which this project's test fixtures follow. No code was copied. This project exists because that one reports errors on Little Snitch 6.5 (its issues 199 and 201) and had no commit since April 2026 when this one started.

## License

MIT. See [LICENSE](LICENSE).
