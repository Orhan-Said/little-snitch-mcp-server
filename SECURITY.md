# Security

This server lets a language model read and, if you allow it, change a firewall. This page says what the server defends against, what it does not, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting on this repository: Security > Report a vulnerability. Say which version you run, what you did and what happened. You will get an answer within a week.

## What the server defends against

The assistant is tricked. A web page, a document or a host name can carry text that tells the assistant to open the firewall. The defenses are:

- The server starts read-only. A tool you did not name with `--allow` is not registered, so the assistant cannot call it.
- macOS asks you to approve each change with Touch ID or your password. The prompt text says what will change. Nothing the assistant reads can answer that prompt.
- The server refuses a rule for any process and any remote, and refuses to touch protected and factory rules.

The assistant makes a mistake. It may misspell a name or pick the wrong rule.

- The server looks up profiles by exact name and groups by id or name, with no loose matching.
- A rule reference is a hash of the rule's content. If the rule changed since the assistant listed it, the reference no longer matches and the call fails.
- Every rule change has a dry run.

Little Snitch does not take a change as written. It may drop a field or a rule.

- The server saves a backup before each rule change, reads the configuration back afterwards and compares it with what it intended.
- If a rule is missing or changed its meaning, the server restores the backup. If that also fails, the error contains the command to restore it by hand.

Something replaces the `littlesnitch` tool. Before a privileged run the server checks that root owns the file, that others cannot write to it, and that Objective Development signed it.

## What the server does not defend against

- A program that already runs as your macOS user. It can read the backup folder, and it could swap the changed configuration in the moment between the server writing the file and Little Snitch reading it. The server would notice the difference when it reads the configuration back and would restore the backup, but the wrong rules would be active for a moment. Such a program can also show you fake password dialogs. Keep untrusted programs off the Mac.
- You approving a change you did not read. The prompt names the change. Read it.
- Your AI provider. Rules, host names and traffic summaries that the assistant reads become part of the conversation.
- Your own `sudoers` rules. If you let `sudo` run `littlesnitch` without a password, changes need no approval when `--unattended-writes` is on, and any program on the Mac can use that rule. See [docs/root-access.md](docs/root-access.md).
- Changes made in Little Snitch while a rule change runs. The server replaces the whole configuration, so a rule you create in those seconds can be lost.

## Where data goes

The server opens no network connections. It writes to one folder, by default `~/Library/Application Support/little-snitch-mcp-server`:

- `backups/` holds copies of your Little Snitch configuration, at most 50.
- `changes.log` has one line for each change the server tried.
- `pending/` holds a changed configuration for the seconds it takes to apply it.

The folder has mode 0700 and the files 0600, so other users of the Mac cannot read them. The backups list every app and host you have rules for. Delete the folder if you stop using the server.

## Dependencies

Three packages run in the server: `@modelcontextprotocol/sdk`, `zod` and `lossless-json`. CI runs `npm audit` on every push.
