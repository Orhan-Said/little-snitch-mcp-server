# Design

Written on 2026-11-22, before the first release.

## Goal

Let an assistant answer questions about a Mac's Little Snitch firewall and make changes the owner approved. Anyone with Little Snitch 6 and Node.js should be able to install it.

A firewall controller that an assistant drives can do damage, so two things count as failure even if every feature works:

- A change happens that the owner did not approve.
- A change leaves the firewall in a state nobody intended, and the owner does not find out.

## What Little Snitch offers

The only supported way in is `littlesnitch`, the command-line tool inside the app. Facts found on Little Snitch 6.5:

- It needs root for everything except `--version`, `log` and `restrictions`.
- It needs "Allow access via Terminal", which is off by default.
- It can export the whole configuration as JSON (`export-model`) and replace it (`restore-model`). There is no command for one rule. Objective Development's documentation names export, edit and restore as the route for automation.
- It can switch profiles (`profile`) and rule groups (`rulegroup`), print traffic history as CSV (`log-traffic`) and list preferences.

Objective Development does not document the JSON format. The torsday/little-snitch-mcp project recorded it from version 6.3.3, and its issue tracker shows that 6.5 changed at least one field from text to a number.

## Approaches considered

### How to get root

1. Tell users to add a password-free `sudoers` rule. Simple, and the worst choice: any program on the Mac could then change the firewall, `export-model <file>` could overwrite system files, and the tool sits in a folder that the admin group can write to.
2. Install a privileged helper. It would need a signed, notarized binary and an installer. Too much for a project whose users should be able to read all of its code.
3. Use what macOS already has: Touch ID for sudo, and the administrator dialog of `do shell script`. Both prompts come from macOS, and the server never sees a password.

The server uses the third. For a read it tries `sudo` without a prompt first, then Touch ID, then the dialog. A change goes through the dialog only, because `sudo` cannot promise a prompt: a `NOPASSWD` rule makes it silent, and the server cannot see such a rule.

### How to change a rule

1. Write `.lsrules` files. The format is documented, but Little Snitch 6 only subscribes to them over HTTPS with a valid certificate, through its own window. A local server cannot do that.
2. Script the Little Snitch window. Brittle, and it needs Accessibility permission for the assistant's host.
3. Export, edit and restore the configuration. This is the documented route. Its risk is that a restore replaces everything.

The server uses the third and surrounds it with checks: a backup before, a read-back after, a comparison of the whole configuration, and an automatic restore of the backup when the comparison fails.

### How to hold the configuration in memory

The format is undocumented and changes between versions. Typed structures with every field named would break on the next release, which is what happened to the earlier project. The server instead treats the configuration as loose JSON:

- It reads only the fields it needs and passes everything else through untouched.
- It parses numbers losslessly, so a 64-bit value or a number written as `1.0` goes back exactly as it came.
- It reads dates in three forms (ISO text, seconds from 2001, seconds from 1970) and writes a new date in the form the other rules use.
- It shows fields it does not interpret under `other`, so nothing is hidden.

### How to identify a rule

Rules carry no id in the configuration. The server derives a reference from a hash of the rule's content, leaving out the two fields Little Snitch updates on its own (`lastUsed`, `useCount`). A reference therefore stops matching when the rule changes, which protects against editing a rule that is no longer what the assistant saw.

After a change, every rule that was not touched must come back with the same reference. The rule that was written must come back with every field as sent, known to this server or not. Only its dates and a short list of spellings may differ: a default left out or written out, a protocol as a name or a number, one remote as text or as a list.

### What the assistant may do by default

Nothing but read. The owner names the kinds of change at startup. A tool that is not allowed is not registered, so it does not appear in the assistant's tool list and cannot be called.

## What is left out of the first release

- Preferences cannot be changed. One preference switches terminal access off, and others stop the filter. A safe list of keys needs testing on a real install first.
- A rule cannot be placed in a profile or created disabled. The field names are not confirmed.
- Packet capture (`capture-traffic`) and live streams. They run until stopped and return payload data.
- Subscribing to blocklists and answering connection alerts. The command-line tool cannot do either.

## What an outside review changed

Before the first release, three models from other vendors reviewed the repository independently (2026-11-22). Two ruled "fix first" and one "reject". All three confirmed that tools exist only when allowed and that root commands are built without injection. Their findings, all reproduced against the simulator, led to these changes:

| Finding | Change |
|---|---|
| The check after a change accepted extra rules, ignored some fields of the new rule, and did not look at preferences | The whole configuration is compared. Any difference fails the change and it is undone. |
| A failed read-back or a timeout after the write did not lead to an undo | The server reads again and undoes what differs. |
| With a `NOPASSWD` rule, `sudo -k` ran a change without a prompt while the docs promised one | Changes go through the administrator dialog only. The status tool names the settings that remove approval. |
| The prompt was cut at 240 characters and could hide the remote | The prompt is built from fields, action and remote first. A remote list that does not fit is refused. |
| A failed `restore_backup` left a partial restore active | It restores the configuration from before and checks it. |
| Two changes at once could lose one | One change at a time, with a lock file across processes. |
| "Rolled back" was reported without a full comparison | The undo is compared with the configuration from before, in full. |
| Group names matched without regard to letter case | Exact match only. |

One change went further than the reviewers asked: the file to restore is now copied into a folder only root can enter and checked against a checksum before Little Snitch reads it. The second round of that review, in which the reviewers examine each other's findings, did not complete.

The same three models then reviewed the fixed code, this time in both rounds. All three ruled "fix first". They confirmed that the first set of fixes works as described, and found thirteen things in the new code. None was refuted in the second round.

| Finding | Change |
|---|---|
| Two processes could both take a stale lock file, and a live holder lost it after 20 minutes | The lock is held by the kernel through `/usr/bin/lockf`. It frees itself when the holder dies and is never taken over. |
| A logging or cleanup failure after a verified change came back as an error | These can no longer fail a change. The result carries a warning. |
| Prompts for changing or removing an existing rule cut long remote lists | Such a rule cannot be changed or removed through the server. |
| Saving the copy before a restore could prune the backup being restored | The target is exempt from pruning, and root restores the content already read, from a fresh file. |
| A timed-out dialog could leave the root command running while recovery started a second restore | After a timeout nothing further is started. The state is reported as unknown. |
| Profile and group switches had no backup and no undo, and reported "applied" without a confirming read-back | They get a backup, a check and an undo. An unconfirmed profile switch answers "accepted". |
| A group switch resolved the name from a copy up to ten minutes old | The group is resolved from a read made inside the lock. |
| The comparison ignored rule-list entries that are not objects | Every entry of the rule list is compared. |
| The manual restore command was not shell-quoted | Every path in it is quoted. |
| The update prompt showed the old action last, and no prompt showed notes or a foreign user id | The prompt ends with the rule as it will be, and shows the note and the user. |
| The docs said `--unattended-writes` always removes the approval | The docs and the status tool say it has no effect in dialog mode. |
| The rule match ignored remote-list entries that are not text | A list with such an entry must match exactly. |
| `create_backup` could prune a restore target | A restore no longer depends on the backup file once it has been read. |

At this point the reviewers' remaining objections are premises nobody can check without a real Little Snitch: whether the root script works under a real administrator dialog, whether the list of ignored sections and the rule match fit version 6.5, whether macOS shows a long prompt whole, and what a killed dialog leaves running. A third review cannot settle those. A run of `npm run live-check -- --write` can.

## What a real configuration showed

On 2026-11-23 the owner of a Mac with Little Snitch 6.5 ran `npm run live-check`. It was the first run with real privileges. The report holds key names, counts and formats only.

What it confirmed:

- The administrator dialog works with a real password, and three commands run under one approval with their outputs taken apart correctly. The configuration alone was about 530 KB.
- `restrictions` without root tells whether terminal access is on.
- The top-level sections are the ones the earlier project recorded, plus `knownNEs`.
- Rule dates are ISO text. `lastUsed` is a number of seconds counted from 2001.
- `remote-domains` is text or a list. `remote-hosts` and `remote-addresses` were text in every rule.
- The traffic log has exactly the documented columns. Its dates are ISO text in UTC. A window given in local time returned rows, which fits the assumption that the tool reads its date arguments as local time.
- The preference listing has one `key = value` per line.

What it corrected:

- Rule groups have no `kind` and no `name`. The kind is under `type`, and a name the person gave is under `userProvidedName`. The server reads both spellings now. Before this, every group on 6.5 would have shown without a name.
- Rule actions also include `ask` and `suggestion`, and directions include `both`.
- The per-user preferences hold keys that change while Little Snitch runs. Five of them are now left out of the comparison.
- The owner's screenshot of Settings > Security showed Little Snitch's own switches for rule editing and profile switching. The server now reads them and refuses what is switched off.

What it could not show:

- No rule had the origin `frontend`, which the server writes for a new rule. The origins seen were `alert`, `expiredTemporary`, `factory`, `monitor`, `osUpdate`, `preLogin` and `unknown`.
- No rule had notes, so the key `notes` is confirmed only by the `.lsrules` documentation.
- There were no profiles, so their shape and the place of the active profile are still unknown.
- Nothing was written. Whether `restore-model` takes a changed configuration as sent is the open question the write check answers.

## Open questions

These need a run that changes something. `npm run live-check -- --write` adds and removes one test rule and reports what differed.

- Whether `restore-model` accepts a new rule with the origin `frontend` and a `notes` field, and returns it as sent.
- Whether a restore changes anything outside the rule list on its own. The check after a change is strict, so every such part must either stay the same or be on one of two short lists in `src/model/verify.ts`: `LITTLE_SNITCH_OWNED_SECTIONS` and `VOLATILE_PREFERENCE_KEYS`. If a list is too short for 6.5, the change is undone and the error names the part or the key.
- Whether Little Snitch respells a rule in a way `tolerantKey` in `src/model/rules.ts` does not expect.
- Which key holds the active profile.
- Whether macOS shows a prompt of about 1,000 characters whole in the administrator dialog.
- Whether a command started by the administrator dialog keeps running when `osascript` is killed. Without administrator rights it does.
