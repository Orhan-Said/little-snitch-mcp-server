# Changes

How the server makes a change, what a result says, and what to do when a change fails.

## How a change runs

Little Snitch has no command for one rule. The server exports the whole configuration, changes it and restores it, one change at a time:

1. It reads the configuration and saves it as a backup.
2. It writes the changed configuration to a file and notes the file's checksum.
3. macOS shows the administrator dialog. After the person approves it, root copies the file to a folder only root can enter, checks the checksum, and has Little Snitch restore that copy.
4. It reads the configuration back under the same approval.
5. It compares every rule, rule group, profile and preference with what it intended.
6. On any difference, it restores the configuration from step 1 and reports what differed.

Profile and rule group switches use Little Snitch's own `profile` and `rulegroup` commands in place of the restore, with the same backup and comparison.

One lock for the whole Mac keeps two changes apart, even between two copies of the server. A second change waits its turn inside one server, and another server reports `busy`.

## The dry run

`add_rule`, `update_rule`, `remove_rule` and `restore_backup` take `dry_run: true`. Nothing changes, and the result has `applied: false` and `dryRun: true`.

For the three rule tools, the result has a `preview`:

- `wouldAdd` for `add_rule`: the rule as it would be added;
- `before` and `after` for `update_rule`;
- `wouldRemove` for `remove_rule`;
- `approvalPrompt` for all three: the exact text the administrator dialog will show.

For `restore_backup`, the result has an `effect` instead: how many rules would go (`rulesRemoved`) and come back (`rulesAdded`), up to ten examples of each, and which other parts of the configuration would change.

Show the person the preview, or the effect, before the real call.

## The approval dialog

The dialog names the change with the action and the remote first, then the process, a note if the rule has one, and the macOS user if the rule belongs to another user. For example:

`Little Snitch MCP wants to ADD a firewall rule: DENY connections to the domains tracker.example for /Applications/Slack.app/Contents/MacOS/Slack.`

For a change to an existing rule, the text ends with the rule as it will be. Tell the person to read it and to approve only if it matches what you told them. The dialog is outside your reach, and that is the point of it.

## What a result says

A change that went through has `applied: true`, the name of the backup saved before it (`backup`), and how it was approved (`approvedThrough`). It may also have:

- `warnings`: things the person should know, for example that the change log could not be written, or that the server could not read one of Little Snitch's Security switches. Pass each one on.
- `rewrittenByLittleSnitch`: sections Little Snitch changed by itself during the restore, such as `knownNEs` or `developerTeamNames`. The server does not compare them, so say that they changed.

A profile switch whose result the configuration does not show answers "accepted" instead of "applied". Tell the person to check the active profile in Little Snitch.

## Failures

Every failure has a `kind`, a `message`, and often a `remedy` written for the person. Pass the remedy on in plain words.

| Kind | What it means | What to do |
|---|---|---|
| `not-installed` | Little Snitch or its tool was not found. | Pass the remedy on. |
| `untrusted-binary` | The tool failed the owner or signature check. | Stop. Tell the person; do not look for another tool. |
| `terminal-access-disabled` | "Allow access via Terminal" is off. | The person switches it on in Little Snitch, Settings, Security. |
| `needs-root`, `elevation-unavailable` | The server could not get root. | Pass the remedy on. [Root access](setup-and-recovery.md#root-access) has the choices. |
| `elevation-cancelled` | The person cancelled the dialog or the prompt. | Do not retry unless they ask. |
| `elevation-failed`, `cli-failed`, `unexpected-output` | The tool failed or answered in a way the server does not know. | Report the message. Do not retry in a loop. |
| `capability-disabled` | That kind of change is not allowed, or Little Snitch's own Security switch is off. | Explain how the person can allow it, and stop. |
| `invalid-input` | An input was wrong, the rule would copy another rule, or the dialog could not show the rule exactly (a remote list too long, invisible characters). | Read the message. Fix the input, or tell the person to change that rule in Little Snitch itself. |
| `not-found`, `ambiguous` | A ref is stale, or a name matched nothing or more than one. | List again and use the exact ref or name. |
| `protected` | A protected or factory rule. | The person can change it in Little Snitch itself. |
| `busy` | Another change holds the lock. | Wait, then try once more. Never touch the lock file. |
| `timeout` | A command did not end in time. | See below. |
| `tampered` | A file changed between the approval and its use. | Stop. Nothing ran. Tell the person. |
| `verification-failed` | Little Snitch did not take the change as written. | The server restored the earlier configuration. Report what differed. Do not retry the same change. |

### After a timeout

A command that timed out may still be running as root. The server starts nothing further for that change, keeps the lock, and refuses every later change until a minute has passed and no `littlesnitch` command that changes the configuration is running. Its message says that the state is unknown and gives a command to restore the backup by hand, with the checksum the backup file must have.

Do not retry. Tell the person the state is unknown and pass the command on for them to run in their own Terminal if they choose. Do not run it yourself.

### When the undo fails too

If the server cannot restore the earlier configuration, the error gives the same restore command with the backup's checksum. Pass it on and stop.

## What the person should know

- During a change, the person should not change anything in Little Snitch, not even answer a connection alert. The server would see a difference and restore the backup, and that change of theirs would be gone. The error lists it.
- New rules apply in all profiles. The server cannot put a rule into one profile or create a rule that is switched off.
- The server cannot answer connection alerts, create profiles, subscribe to blocklists, change preferences or capture packets.
- Rules, host names and traffic that the tools return become part of the conversation and reach the AI provider.
