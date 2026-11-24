# Security

This server lets a language model read and, if you allow it, change a firewall. This page says what the server defends against, what it does not, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting on this repository: Security > Report a vulnerability. Say which version you run, what you did and what happened. You will get an answer within a week.

## What the server defends against

The assistant is tricked. A web page, a document or a host name can carry text that tells the assistant to open the firewall. The defenses are:

- The server starts read-only. A tool you did not name with `--allow` is not registered, so the assistant cannot call it. The Claude Code and Codex plugins start it read-only too: changes need the plugin option in Claude Code, or a registration of your own with `--allow`.
- macOS asks you to approve each change in the administrator dialog. The prompt states the change, with the action and the remote first. Nothing the assistant reads can answer that prompt.
- The server refuses to create a rule for any process and any remote, refuses to change the action or priority of such a rule, and refuses to touch protected and factory rules.
- It looks at Little Snitch's own switches "Allow Rule Editing" and "Allow Profile Switching" in the configuration and refuses what you switched off. A value it does not understand counts as off. This is a courtesy and not a boundary: the command-line tool runs as root and ignores the switches, and when the key is missing the server goes on and says so in the result.
- It refuses a rule that the prompt could not show exactly: a remote list that does not fit, two remote fields, a list entry that is not text, a value that would be cut, or a path with invisible characters. So the prompt cannot hide part of a rule that is added, changed or removed.
- The prompt for a change to a rule ends with the rule as it will be afterwards.

The assistant makes a mistake. It may misspell a name or pick the wrong rule.

- The server looks up profiles and groups by exact id or name, including letter case.
- A rule reference is a hash of the rule's content. If the rule changed since the assistant listed it, the reference no longer matches and the call fails.
- Every rule change has a dry run, which also returns the text of the approval prompt.

Little Snitch does not take a change as written. It may drop a field or a rule.

- The server saves a backup before each rule change, reads the configuration back afterwards and compares every rule, rule group, profile and preference with what it intended. An extra rule, a different field or a changed preference is a difference. It does not compare seven sections that Little Snitch keeps for itself (`blocklistStatistics`, `statisticsModelCreationDate`, `lastSeenExecutableByCodeIdentifier`, `developerTeamNames`, `knownNEs`, `bundleVersion`, `factoryRuleSetVersion`) and seven preference keys that change while Little Snitch runs (listed in the README). When one of the seven sections differs, the result names it under `rewrittenByLittleSnitch`.
- On any difference the server restores the configuration from before, which it still holds in memory, and compares again. If that fails, the error contains the command to restore the backup file by hand, with the checksum the file must have.
- If a step fails after the change may have run, the server reads the configuration again and undoes what differs.
- After a timeout the command may still be running as root. The server then starts nothing further for that change, says that the state is not known, and gives the command to restore by hand. It keeps the lock and refuses every later change until a minute has passed and no `littlesnitch` command that changes the configuration shows in the list of running programs.
- A profile or rule group switch gets the same backup, check and undo. A rule group switch must leave everything else unchanged. A profile switch may change the key that names the active profile and nothing else.

Another program swaps the file. The changed configuration lies in a folder your own programs can write to.

- Under the administrator dialog, root copies the file into a fresh folder inside `/private/var/root` that only root can enter, checks the copy against a checksum, and restores the copy. A swap after your approval makes the checksum fail, and nothing runs.
- Without the dialog (`--unattended-writes` or `--elevation none`) the server checks the checksum right before it starts the tool. A short gap remains between that check and the read. The comparison afterwards still catches a swapped configuration and undoes it.

Two changes run at once. Within one server, changes queue up and run one at a time. While a change runs, the server holds a lock through macOS's `lockf`. The kernel holds that lock and frees it when the server dies, so it cannot be left behind. A second copy of the server that finds it taken reports that it is busy. The lock is one file for the whole Mac, `/private/var/tmp/little-snitch-mcp-server.lock`, whatever user, home folder or data folder a server has. A small helper process holds the lock for the server. If that helper dies, the server notices before its next privileged command and does not run it. Before each change the server also reads the list of running programs and makes no change while a `littlesnitch` command that changes the configuration is running, whoever started it.

Something replaces the `littlesnitch` tool. Before a privileged run the server checks that root owns the file, that others cannot write to it, that it is not a symbolic link, and that Objective Development signed it.

## What the server does not defend against

- A program that already runs as your macOS user and wants to fool you. It can read the backup folder, and it can show you a fake password dialog. Keep untrusted programs off the Mac.
- You approving a change you did not read. The prompt names the change. Read it.
- Your AI provider. Rules, host names and traffic summaries that the assistant reads become part of the conversation.
- An agent that goes around the server. The plugin's skill tells the agent never to run `littlesnitch` itself, never to edit Little Snitch's files and never to touch the approval or the lock, but that is advice to a language model. An agent that can run shell commands can still run `sudo littlesnitch` outside this server. macOS then asks for your password in a terminal, and none of the server's checks, backups or comparisons run. Approve only prompts you expect.
- Settings that switch the approval off. With `--unattended-writes`, a change runs through `sudo`, and `sudo` asks nobody when a password-free rule matches or an earlier approval is still remembered. With `--elevation none`, nobody is ever asked. `get_status` reports both in capital letters.
- A password-free `sudoers` rule for `littlesnitch`. This project does not suggest one. If you have one, any program on the Mac can use it without this server. See [docs/root-access.md](docs/root-access.md).
- Changes you make in Little Snitch while a rule change runs. The check sees them as a difference and the server restores the backup, which removes them. The error lists what it removed.
- A profile switch whose result it cannot read. Where Little Snitch keeps the active profile is not documented. If Little Snitch accepts the switch and the configuration is the same as before, the server answers "accepted" and not "applied", and the change log says "accepted" too.
- A change inside the parts it does not compare. A wrong `knownNEs` or `developerTeamNames` would be reported by name and not undone.
- A user of the Mac who holds or removes the lock file. Holding it keeps the server from making changes. Removing it while a change runs lets a second change start.
- A root command that outlives a timeout and does not show in the list of running programs as a `littlesnitch` command. The server cannot stop a process that runs as root. It reports the state as unknown and waits, but it cannot prove that the command is gone.
- A restart of the server during the wait after a timeout. The wait is kept in memory. After a restart only the look at the list of running programs protects the next change.
- A Little Snitch version that stores the Security switches under other keys. The server then cannot respect them, and says so in each result.

## Where data goes

The server opens no network connections. It writes to one folder, by default `~/Library/Application Support/little-snitch-mcp-server`:

- `backups/` holds copies of your Little Snitch configuration, at most 50.
- `changes.log` has one line for each change the server tried.
- `pending/` holds a changed configuration for the seconds it takes to apply it. After a timeout the file stays until the next change, because the command may still be reading it.
- `changes.log` failing to be written does not fail a change. The result carries a warning.

The lock file is outside that folder, at `/private/var/tmp/little-snitch-mcp-server.lock`. It is empty and readable by every user of the Mac, so that all of them share it.

The folder has mode 0700 and the files 0600, so other users of the Mac cannot read them. The backups list every app and host you have rules for. Delete the folder if you stop using the server.

## Dependencies

Three packages run in the server: `@modelcontextprotocol/sdk`, `zod` and `lossless-json`. The npm package carries them and their own dependencies inside it (`bundleDependencies`), because Codex installs a plugin from npm without installing its dependencies. What runs is therefore the set that `package-lock.json` named when the release workflow built the package, whether you install the plugin or run `npx`. CI runs `npm audit` on every push, and the release workflow runs it before staging. Dependabot proposes updates weekly, each at least a week old, and CodeQL scans the code and the workflows.

## Releases

Version 0.1.0 was published to npm by hand, because npm accepts a workflow as publisher only for a package that already exists. Later versions are built by `.github/workflows/release.yml` from a `v*` tag, through npm's trusted publishing, and no npm token exists. npm lets the workflow only stage a version. A staged version stays hidden until the maintainer approves it on npm with two-factor authentication, so a stolen GitHub account cannot release anything alone. The package also requires two-factor authentication for every publish and refuses tokens. The workflow asks for a provenance statement that names the commit and the workflow run, and fails without one. The plugin marketplaces name the same exact version, so a plugin install gets the package you approved. [docs/releasing.md](docs/releasing.md) has the steps. To check a release you installed:

```bash
npm audit signatures
```

Release tags cannot be moved or deleted, and the workflow uses only GitHub's own actions, each pinned to a commit.
