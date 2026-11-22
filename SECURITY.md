# Security

This server lets a language model read and, if you allow it, change a firewall. This page says what the server defends against, what it does not, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting on this repository: Security > Report a vulnerability. Say which version you run, what you did and what happened. You will get an answer within a week.

## What the server defends against

The assistant is tricked. A web page, a document or a host name can carry text that tells the assistant to open the firewall. The defenses are:

- The server starts read-only. A tool you did not name with `--allow` is not registered, so the assistant cannot call it.
- macOS asks you to approve each change in the administrator dialog. The prompt states the change, with the action and the remote first. Nothing the assistant reads can answer that prompt.
- The server refuses a rule for any process and any remote, and refuses to touch protected and factory rules.
- It refuses paths and notes with invisible characters, and a rule whose remote list does not fit into the prompt, so the prompt cannot hide part of a change.

The assistant makes a mistake. It may misspell a name or pick the wrong rule.

- The server looks up profiles and groups by exact id or name, including letter case.
- A rule reference is a hash of the rule's content. If the rule changed since the assistant listed it, the reference no longer matches and the call fails.
- Every rule change has a dry run, which also returns the text of the approval prompt.

Little Snitch does not take a change as written. It may drop a field or a rule.

- The server saves a backup before each rule change, reads the configuration back afterwards and compares all of it with what it intended. An extra rule, a different field or a changed preference is a difference.
- On any difference the server restores the configuration from before, which it still holds in memory, and compares again. If that fails, the error contains the command to restore the backup file by hand, with the checksum the file must have.
- If a step fails after the change may have run, for example a timeout, the server reads the configuration again and undoes what differs.

Another program swaps the file. The changed configuration lies in a folder your own programs can write to.

- Under the administrator dialog, root copies the file into a fresh folder inside `/private/var/root` that only root can enter, checks the copy against a checksum, and restores the copy. A swap after your approval makes the checksum fail, and nothing runs.
- Without the dialog (`--unattended-writes` or `--elevation none`) the server checks the checksum right before it starts the tool. A short gap remains between that check and the read. The comparison afterwards still catches a swapped configuration and undoes it.

Two changes run at once. Within one server, changes queue up and run one at a time. The server holds a lock file while a change runs, and a second copy of the server that finds the lock taken reports that it is busy.

Something replaces the `littlesnitch` tool. Before a privileged run the server checks that root owns the file, that others cannot write to it, that it is not a symbolic link, and that Objective Development signed it.

## What the server does not defend against

- A program that already runs as your macOS user and wants to fool you. It can read the backup folder, and it can show you a fake password dialog. Keep untrusted programs off the Mac.
- You approving a change you did not read. The prompt names the change. Read it.
- Your AI provider. Rules, host names and traffic summaries that the assistant reads become part of the conversation.
- Settings that switch the approval off. With `--unattended-writes`, a change runs through `sudo`, and `sudo` asks nobody when a password-free rule matches or an earlier approval is still remembered. With `--elevation none`, nobody is ever asked. `get_status` reports both in capital letters.
- A password-free `sudoers` rule for `littlesnitch`. This project does not suggest one. If you have one, any program on the Mac can use it without this server. See [docs/root-access.md](docs/root-access.md).
- Changes you make in Little Snitch while a rule change runs. The check sees them as a difference and the server restores the backup, which removes them. The error lists what it removed.
- Profile and rule group switches that do more than they should. For these two the server checks the switch itself, not the rest of the configuration.

## Where data goes

The server opens no network connections. It writes to one folder, by default `~/Library/Application Support/little-snitch-mcp-server`:

- `backups/` holds copies of your Little Snitch configuration, at most 50.
- `changes.log` has one line for each change the server tried.
- `pending/` holds a changed configuration for the seconds it takes to apply it.
- `change.lock` exists while a change runs.

The folder has mode 0700 and the files 0600, so other users of the Mac cannot read them. The backups list every app and host you have rules for. Delete the folder if you stop using the server.

## Dependencies

Three packages run in the server: `@modelcontextprotocol/sdk`, `zod` and `lossless-json`. CI runs `npm audit` on every push.
