# little-snitch-mcp-server

An MCP server for the [Little Snitch](https://obdev.at/littlesnitch) firewall on macOS. With it, an assistant such as Claude can read your firewall rules and traffic history. If you allow it, the assistant can also switch profiles and rule groups, and add, change or remove rules.

The server works through `littlesnitch`, the command-line tool inside the Little Snitch app. It opens no network connections of its own.

It also comes as a plugin for Claude Code and Codex. The plugin brings the server and a skill: instructions that tell the agent to read the status first, to show you a dry run before a change, and never to go around the server.

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
| The administrator dialog with a real password, with four reads under one approval | On Little Snitch 6.5 |
| Reading and parsing a real configuration of several hundred rules, the preference listing and the traffic history | On Little Snitch 6.5. Only key names, counts and formats were recorded. |
| The lock that keeps two changes apart | With macOS `lockf`: twelve takers at once, a holder that is killed, a helper process that is killed, and a lock file the taker cannot write to. The real add and remove ran under it. Two macOS users at once were not tried. |
| The wait after a change that did not end in time | Against the simulator, with a restore that outlives the process that started it. The look at the process list ran against a real process on macOS 26.6, and before both real changes without a false alarm. A real administrator dialog that times out was not tried. |
| The restore under the administrator dialog, with its checked private copy in root's folder | On Little Snitch 6.5 |
| Adding a rule and removing it again, each followed by the comparison of every rule, rule group, profile and preference | On Little Snitch 6.5, last with the version in this repository. It passed on the second attempt. The first attempt found three parts that Little Snitch rewrites by itself during a restore, and the server undid the change. |
| The undo after a failed check | On Little Snitch 6.5, in that first attempt: it put every rule back |
| Listing and filtering rules, groups, traffic and preferences | Against the simulator in `tests/fixtures/fake-littlesnitch.mjs`, whose configuration has the shape of that real one |
| Changing a rule, restoring a backup, switching rule groups and profiles | Against the simulator, which does on every restore what the real tool did |
| Profiles | Against the simulator only. The real configuration had none, so their shape comes from older notes. |
| Touch ID for sudo | Not run |
| The Claude Code and Codex plugin | A test packs the package, unpacks it outside the repository and starts the server from there. `claude plugin validate` passes, and Claude Code 2.1.331 started the plugin's server read-only from a folder. Codex 0.170 installed it from a local marketplace into a throwaway settings folder. Installing from npm waits for the first release that holds the plugin. |

The simulator follows Objective Development's documentation, the shape of a real Little Snitch 6.5 configuration, and for what that configuration did not contain, the format that the [torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) project recorded from Little Snitch 6.3.3. Where your Little Snitch differs, the server reports what it could not read. It does not guess.

The check after a change is strict. If Little Snitch rewrites something this project does not know about, the server undoes the change and tells you which part differed, down to the name of the preference key. That happened on the first real change, and it may happen again on a version of Little Snitch nobody has tried, or with a kind of change nobody has tried on a real one. You can find out on your own Mac in two minutes. See [Check it on your Mac](#check-it-on-your-mac).

## Requirements

- macOS with Little Snitch 6. The server was built against version 6.5.
- Node.js 22.12 or newer.
- An administrator account on the Mac.
- In Little Snitch, open Settings, go to Security, and switch on "Allow access via Terminal" in the group "Other". Little Snitch keeps this off by default, because its command-line tool can change the firewall. Switch it on only if you want to use this server.

## Install

The package is on npm as [`little-snitch-mcp-server`](https://www.npmjs.com/package/little-snitch-mcp-server). Install it as a plugin, or register it as an MCP server yourself. Use one of the two, not both: two registrations show every tool twice.

### As a plugin for Claude Code or Codex

The plugin starts the server from the package it was installed with, and the server starts read-only.

Claude Code 2.1.275 or later:

```text
/plugin install little-snitch --marketplace Orhan-Said/little-snitch-mcp-server
```

In older versions, add the marketplace first:

```text
/plugin marketplace add Orhan-Said/little-snitch-mcp-server
/plugin install little-snitch@little-snitch
```

Claude Code asks which changes the assistant may make. Leave the answer empty to only read. [Allowing changes](#allowing-changes) explains the values.

Codex:

```bash
codex plugin marketplace add Orhan-Said/little-snitch-mcp-server
codex plugin add little-snitch@little-snitch
```

Start a new session afterwards. Ask the assistant to "check the Little Snitch status".

Both marketplaces name one exact version of the package, and Claude Code does not update third-party plugins by itself. To update, read the [changelog](CHANGELOG.md), then run `claude plugin update little-snitch@little-snitch` in Claude Code, or `codex plugin marketplace upgrade little-snitch` in Codex.

To use the skill without the plugin, copy the [`skills/little-snitch`](skills/little-snitch) folder into your agent's skills folder (`~/.claude/skills/` for Claude Code, `~/.agents/skills/` for Codex) and register the server as below.

### As an MCP server

Your MCP client starts the server with `npx`, which downloads it the first time.

Claude Desktop, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "little-snitch": {
      "command": "npx",
      "args": ["-y", "little-snitch-mcp-server@0.1.0"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add little-snitch -- npx -y little-snitch-mcp-server@0.1.0
```

Codex:

```bash
codex mcp add little-snitch -- npx -y little-snitch-mcp-server@0.1.0
```

The examples name a version on purpose. This server can change your firewall, so a new version should run only when you choose it. Without a version, `npx` may start a newer release the next time your client starts. To update, read the [changelog](CHANGELOG.md) and change the number.

If Claude Desktop reports that it cannot find `npx`, put the full path in `command`. `which npx` prints it, for example `/opt/homebrew/bin/npx`.

Started this way, the server only reads. Ask the assistant to "check the Little Snitch status". The `get_status` tool lists what is still missing on your Mac.

### From source

To read the code before you run it, or to run the [check on your Mac](#check-it-on-your-mac):

```bash
git clone https://github.com/Orhan-Said/little-snitch-mcp-server.git
cd little-snitch-mcp-server
npm install
npm run build
```

Then use `"command": "node"` with `"args": ["/absolute/path/to/little-snitch-mcp-server/dist/index.js"]` in place of the `npx` lines above.

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
"args": ["-y", "little-snitch-mcp-server@0.1.0", "--allow", "switches,rules"]
```

With the plugin:

- In Claude Code, the plugin option "Changes the assistant may make" takes the same list. Claude Code asks for it when you enable the plugin. To change it later, use `/config` or `claude plugin configure little-snitch@little-snitch`, then start a new session.
- In Codex, the plugin's server takes no options. Turn it off in `~/.codex/config.toml` and register the server yourself with `--allow`. The plugin's skill stays.

  ```toml
  [plugins."little-snitch@little-snitch".mcp_servers.little-snitch]
  enabled = false
  ```

  ```bash
  codex mcp add little-snitch-changes -- npx -y little-snitch-mcp-server@0.1.0 --allow switches,rules
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
| `set_active_profile` | `switches` | Activates a profile by its exact name, or deactivates all profiles. Answers "accepted" instead of "applied" when the configuration does not show the active profile and nothing else changed. |
| `set_rule_group_enabled` | `switches` | Switches a rule group or blocklist on or off, by its exact id or name. Runs nothing when the group is already in that state. |
| `add_rule` | `rules` | Adds an allow or deny rule for a process and a remote. |
| `update_rule` | `rules` | Changes the action, priority or notes of one rule. Refuses a change that would make the rule a copy of another one. |
| `remove_rule` | `rules` | Removes one rule. |
| `restore_backup` | `restore` | Replaces the whole configuration with a saved backup. |

`add_rule`, `update_rule`, `remove_rule` and `restore_backup` take `dry_run: true`. A dry run changes nothing and returns what would happen, including the text of the approval prompt.

## How a rule change works

Little Snitch has no command to edit one rule. Its documented route for automation is to export the whole configuration, change it and restore it. The server does that one change at a time. A lock that macOS holds for the server keeps two copies of the server apart: the second one reports that it is busy. The lock is one file for the whole Mac (`/private/var/tmp/little-snitch-mcp-server.lock`), because Little Snitch has one configuration for all users. It frees itself if the server dies. Before each change the server also looks at the list of running programs, and makes no change while a `littlesnitch` command that changes the configuration is running.

1. It reads the configuration and saves it as a backup in its data folder.
2. It writes the changed configuration to a file and notes the file's checksum.
3. It asks macOS for the administrator dialog. As root, a small script copies the file into a folder only root can enter, compares the copy with the checksum, and has Little Snitch restore the copy. Another program of yours cannot swap the file after you approved.
4. Under the same approval, it reads the configuration back.
5. It compares every rule, rule group, profile and preference with what it intended. A rule nobody asked for, a field of the new rule that came back different, and any change to preferences, rule groups or profiles count as a difference.
6. If there is a difference, it restores the configuration it read in step 1, compares again, and reports the failure. If that fails too, the error gives you the command to restore the backup by hand, with the checksum the backup file must have.

The comparison is strict, but it is not a comparison of every byte. Three things do not count:

- What Little Snitch updates as traffic flows: a rule's `lastUsed` and `useCount`.
- Seven sections that Little Snitch keeps for itself: `blocklistStatistics`, `statisticsModelCreationDate`, `lastSeenExecutableByCodeIdentifier`, `developerTeamNames`, `knownNEs`, `bundleVersion` and `factoryRuleSetVersion`. A real restore came back with `developerTeamNames` and `knownNEs` rewritten. What `knownNEs` holds, and whether it affects filtering, is not known. When one of these sections differs, the result names it under `rewrittenByLittleSnitch`, so it does not change unseen.
- Seven preference keys that hold no policy and change while Little Snitch runs: `pidOfLSCShowingWelcomeWindow`, `ipAddressDatabaseLastUpdateCheck`, `ipAddressDatabaseLastUpdateCheckFailed`, and the map position under both spellings that were seen, `GeoViewMyLocationLatitude`, `GeoViewMyLocationLongitude`, `geoViewMyLocationLatitude` and `geoViewMyLocationLongitude`.

For the rule just written, its dates and a few spellings may also differ, for example `tcp` and `6`. The lists are in `src/model/verify.ts`.

If the read-back fails, the server reads the configuration again and undoes the change when it differs from before.

A timeout is different. The command that was started may still be running as root, and anything started on top of it could collide with it. So after a timeout the server starts nothing further for that change. It tells you that it does not know whether the change is in effect, and gives you the command to restore the backup by hand. It also keeps the lock and refuses every later change until a minute has passed and the list of running programs shows no such command any more. That holds for other copies of the server on the Mac too.

Profile and rule group switches follow the same steps, with Little Snitch's own `profile` and `rulegroup` commands in place of the restore. The check is as strict. For a rule group, everything must afterwards equal the earlier configuration with that one group switched. For a profile, only the key that names the active profile may differ. If anything else differs, the server puts the earlier configuration back.

A change log that cannot be written does not fail a change, and neither does a temporary file that cannot be removed. The result then carries a warning.

## Safety

An assistant that can change a firewall deserves suspicion. The server takes these measures:

- It starts read-only. A tool you did not allow is not offered to the assistant at all.
- macOS asks you to approve each change in the administrator dialog, outside the assistant's reach. A web page or document that tricks the assistant cannot answer that prompt.
- The prompt is built from the rule's fields, with the action and the remote first, then the process, a note if there is one, and the macOS user if the rule belongs to someone else. A long process path keeps its beginning and its end. For a change to a rule, the prompt ends with the rule as it will be.
- A rule that the prompt could not show exactly cannot be added, changed or removed through the server. That covers a remote list that does not fit, two remote fields in one rule, a list entry that is not text, a value the prompt would have to cut, and paths with invisible characters. Such rules can exist in Little Snitch already. Change them there.
- Before it runs the tool as root, the server checks that the file is owned by root, that nobody else can write to it, and that Objective Development signed it (team `MLZF7K7B5R`).
- It tells the tool for which macOS user it acts (`-u`). Without that, a restore run as root adds a preferences record for the root user to your configuration.
- It passes arguments to the tool as a list, with no shell in between. The administrator dialog is the one place that needs a shell string. There, the server quotes every word and hands the string to AppleScript as an argument.
- It refuses to create a rule for any process and any remote, which would switch the firewall off or cut the Mac off from the network. It also refuses to change the action or the priority of such a rule.
- It refuses to change or remove protected rules and factory rules.
- It looks at Little Snitch's own switches under Settings > Security. With "Allow Rule Editing" off for your user, it changes no rule, rule group or blocklist. With "Allow Profile Switching" off, it switches no profile. A switch with a value the server does not understand counts as off. This is a courtesy, not a barrier: the command-line tool itself is not held back by these switches. See the limits below.
- It matches profile and group names exactly, including letter case, so a typo cannot switch a different one.
- It keeps backups and a change log (`changes.log`) in a folder only your macOS user can read.

The server tells the assistant that process paths, host names and rule notes are data, not instructions. That is advice to a language model, not a guarantee. The approval prompt and the `--allow` list are the guarantees.

[SECURITY.md](SECURITY.md) lists what the server does not protect against.

## Limits

- Rule lists and traffic summaries become part of your conversation, so your AI provider receives them. Do not use the server if that is not acceptable.
- A rule change replaces the whole configuration. If you change something in Little Snitch during those seconds, for example by answering a connection alert, the check sees a difference and the server restores the backup. Your change is then gone, and the error lists it. Finish the approval before you go back to Little Snitch.
- Where Little Snitch keeps the active profile is not documented. The server looks for a preference key such as `activeProfile`. If Little Snitch accepts a switch and the configuration is the same as before, the server answers "accepted" and leaves the check to you. If Little Snitch keeps the active profile under a key the server does not know, the server sees a change it cannot explain and puts the earlier configuration back. Please report that key.
- The server found the two Security switches by their key names in one Little Snitch 6.5 configuration (`allowRuleAndProfileEditing`, `allowProfileSwitching`). There they are numbers, and both read as on while switched on. A switch that is off was not seen. If a key is missing for your user, the server makes the change and says in the result that it could not respect the switch. `get_status` shows what it read: on, off, unreadable or not-found.
- Any user of the Mac can hold the lock file and so keep the server from making changes. The file's owner or an administrator can remove it. Do not remove it while a change runs.
- The wait after a timeout is kept in the server's memory. If you restart the server, the wait is gone, and only the look at the list of running programs protects the next change.
- New rules apply in all profiles. The server cannot put a rule into one profile or create a disabled rule, because the fields for that are not confirmed yet.
- Built-in rule groups have no name in the configuration. The server knows the English names of two of them ("macOS Services", "iCloud Services"). A group or blocklist you named yourself is found by that name. The server shows other groups but cannot switch them.
- The server cannot answer connection alerts, create profiles, subscribe to blocklists, change preferences or capture packets.
- Little Snitch 5 and older are untested.

## Check it on your Mac

In a copy of the repository, after the steps in [From source](#from-source):

```bash
npm run live-check
```

This runs the read-only parts against your Little Snitch and asks for your approval once. It prints key names, counts and value formats only, with no app paths, host names or rule contents, so you can paste the report into an issue.

```bash
npm run live-check -- --write
```

This also adds one deny rule for `/usr/bin/false` to `lsmcp-live-check.invalid`, reads it back and removes it again. That takes four more approvals, or two with Touch ID for sudo. It is the quickest way to learn whether rule editing works with your version of Little Snitch. Make a backup in Little Snitch first, with File > Create Backup. With `--write-only` in place of `--write`, the read checks are left out.

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
npm test               # 403 tests, about 40 seconds
npm run check:package  # packs the package and starts the server from it
npm run typecheck
npm run test:coverage
```

The tests never touch a real Little Snitch. `tests/fixtures/fake-littlesnitch.mjs` stands in for the tool and can misbehave on request. It can drop a rule, flip an action, add a rule nobody asked for, change a preference, switch the wrong group or fail a read-back, so that the check and the undo run. Two tests look at the real tool's ownership and signature when Little Snitch is installed, and skip otherwise.

[docs/design.md](docs/design.md) explains the decisions behind the server, and what three outside reviews changed.

## Related work

[torsday/little-snitch-mcp](https://github.com/torsday/little-snitch-mcp) is an earlier MCP server for Little Snitch, written in Rust. Its design notes recorded how Little Snitch 6.3.3 writes its configuration, which this project's test fixtures follow. No code was copied. This project exists because that one reports errors on Little Snitch 6.5 (its issues 199 and 201) and had no commit since April 2026 when this one started.

## License

MIT. See [LICENSE](LICENSE).
