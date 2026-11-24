# Setup and recovery

What the person needs, how the server gets installed, and what to do when the tools are missing or the server does not start. The person runs every command here. You explain it.

## Requirements

- macOS with Little Snitch 6. The server was built against 6.5.
- Node.js 22.12 or newer, as `node` on the PATH of the agent app.
- An administrator account on the Mac.
- In Little Snitch: Settings, Security, "Allow access via Terminal" switched on, in the group "Other". Little Snitch keeps it off by default because its command-line tool can change the firewall.

## Install

The plugin brings the skill and the server, and starts the server read-only.

In Claude Code 2.1.275 or later:

```text
/plugin install little-snitch --marketplace Orhan-Said/little-snitch-mcp-server
```

In older versions of Claude Code:

```text
/plugin marketplace add Orhan-Said/little-snitch-mcp-server
/plugin install little-snitch@little-snitch
```

In Codex:

```bash
codex plugin marketplace add Orhan-Said/little-snitch-mcp-server
codex plugin add little-snitch@little-snitch
```

Start a new session afterwards, so the client loads the tools.

The skill can also be used alone: copy the `skills/little-snitch` folder of the repository into the agent's skills folder (`~/.claude/skills/` for Claude Code, `~/.agents/skills/` for Codex). That installs these instructions only. Register the server yourself, pinned to a version:

```bash
claude mcp add little-snitch -- npx -y little-snitch-mcp-server@0.1.0
```

```bash
codex mcp add little-snitch -- npx -y little-snitch-mcp-server@0.1.0
```

The version is pinned on purpose. The server can change the firewall, so a new version should run only when the person chooses it.

## Use one registration

Keep one registration of the server per client: the plugin, or one you added yourself, not both. Two registrations show every tool twice. They share the lock, so their changes cannot collide, but which one answers is then up to the model.

## The tools are missing

1. Check that the client lists the server: `/mcp` in Claude Code, `/mcp` or `codex mcp list` in Codex, and `/plugin` or `codex plugin list` for the plugin.
2. If the plugin is installed but the tools are not there, start a new session.
3. If the server is listed as failed, see the next section.

## The server does not start

- Run `node --version`. Anything below 22.12 is too old. A Node from a version manager may not be on the PATH that the agent app sees; the person may need to set the full path to `node` in their client.
- The server runs on macOS only, and it stops at startup when it does not understand a setting. The client's MCP log shows the reason: `/mcp` in Claude Code shows the server's state and error.
- It writes one line to its error output when it starts, naming how it gets root and which changes are allowed, for example `changes allowed: none (read-only)`.

## Root access

Almost every `littlesnitch` command must run as root. The server never sees a password. For reading, it tries in this order:

1. `sudo` without a prompt, when the Mac already allows that.
2. Touch ID for sudo, when the person set it up.
3. The macOS administrator dialog, which needs no setup.

A change always goes through the administrator dialog. [docs/root-access.md](https://github.com/Orhan-Said/little-snitch-mcp-server/blob/main/docs/root-access.md) has the Touch ID setup and explains why the project does not suggest a password-free `sudoers` rule.

## Allowing changes

The server offers its change tools only for the kinds the person allowed:

| Value | What the assistant may do |
|---|---|
| `switches` | Activate a profile or deactivate all profiles; switch a rule group or blocklist on or off. |
| `rules` | Add a rule; change a rule's action, priority or notes; remove a rule. |
| `restore` | Replace the whole configuration with a backup this server saved. |
| `all` | All of the above. |

Each change still needs the person's approval in the administrator dialog.

How the person allows changes depends on the install:

- **Claude Code plugin:** the plugin option "Changes the assistant may make", asked when the plugin is enabled. Empty means read-only. To change it later, use `/config`, or `claude plugin configure little-snitch@little-snitch`. Then start a new session.
- **Codex plugin:** the plugin's server stays read-only. To allow changes, turn the plugin's server off in `~/.codex/config.toml` and register the server yourself with `--allow`:

  ```toml
  [plugins."little-snitch@little-snitch".mcp_servers.little-snitch]
  enabled = false
  ```

  ```bash
  codex mcp add little-snitch-changes -- npx -y little-snitch-mcp-server@0.1.0 --allow rules
  ```

- **A registration of your own:** add `--allow` and a list to the server's arguments, for example `--allow switches,rules`.

Two settings remove the approval for changes. Only the person may choose them, after reading the [README](https://github.com/Orhan-Said/little-snitch-mcp-server#allowing-changes):

- `--unattended-writes` lets a change run through `sudo` like a read. With a password-free `sudo` rule, or shortly after a Touch ID approval, nobody is asked.
- `--elevation none` runs the tool directly and never asks anyone. It works only when the server runs as root.

`get_status` reports both in capital letters. Never add them yourself.

## Report a problem

From a copy of the repository, `npm run live-check` checks the reading parts against the person's own Little Snitch and prints a report without app paths, host names or rule contents. Problems go to [the issue tracker](https://github.com/Orhan-Said/little-snitch-mcp-server/issues). Security problems go through GitHub's private reporting instead, as [SECURITY.md](https://github.com/Orhan-Said/little-snitch-mcp-server/blob/main/SECURITY.md) says.
