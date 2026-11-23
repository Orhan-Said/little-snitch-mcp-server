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

At that point the reviewers' remaining objections were premises nobody could check without a real Little Snitch: whether the root script works under a real administrator dialog, whether the list of ignored sections and the rule match fit version 6.5, whether macOS shows a long prompt whole, and what a killed dialog leaves running. The runs on a real Little Snitch described below settled the first two.

After those runs the same three models reviewed everything that had changed since the first review (2026-11-23). One ruled "reject" and two "fix first". All three confirmed that the thirteen fixes above are in place. The second round did not complete, because one reviewer ran out of time; the two who finished it confirmed each other's findings. What they found, and what changed:

| Finding | Change |
|---|---|
| After a timeout the lock was given back while the root command could still be running, so a later change could be reported as applied and then be overwritten | The server keeps the lock and refuses every change until a minute has passed and the list of running programs shows no `littlesnitch` command that changes the configuration. It looks at that list before every change, so a command left behind by a server that has gone is seen too. An undo that times out is treated the same way. |
| The lock was per home folder, so two macOS users, or one user with two home folders, could overwrite each other | One lock file for the whole Mac, at a fixed place that no setting moves. |
| A profile switch accepted changes to groups and preferences and reported them as applied | Only the key that names the active profile may differ. Anything else is undone. |
| The prompt for an existing rule could leave out a list entry that is not text or a second remote field, and could cut a long keyword | A rule the prompt cannot show exactly is not changed or removed through the server. The same check covers direction, priority, ports, protocol and paths. |
| If the helper process that holds the lock died, the change went on without the lock | The server checks that the lock is still held right before each privileged command, and before an undo. |
| The check of Little Snitch's own switches refused only on an exact `false` | It reads yes and no in every common form, refuses on a value it does not understand, and reports a missing key in the result and in `get_status`. The documents call it a courtesy, which is what it is. |
| The documents said the whole configuration is compared, while seven sections are left out | The documents name the sections and the preference keys. A section that differs is named in the result. The preference keys are matched by their exact spelling. |
| An unconfirmed profile switch was logged as "applied" | It is logged as "accepted". |
| Taking the lock had no time limit | Fifteen seconds. |
| `update_rule` could make a rule a copy of another, or turn a deny rule for any process and any remote into allow | Both are refused. |
| A temporary file that could not be removed was left without a word | The result carries a warning, and the folder is cleared under the lock before the next change. |
| A test depended on the test before it, and the documents miscounted the commands of the real-system check | Both corrected. |

Two things the reviewers asked for were not done. They suggested that the privileged command itself hold the lock until it ends. That would need a root helper installed on the Mac, which this project avoids. And they suggested comparing the seven left-out sections field by field. What Little Snitch writes there was not recorded, so the server reports a difference there by name and does not judge it.

## What a real configuration showed

On 2026-11-23 the owner of a Mac with Little Snitch 6.5 ran `npm run live-check`. It was the first run with real privileges. The report holds key names, counts and formats only.

What it confirmed:

- The administrator dialog works with a real password, and three commands run under one approval with their outputs taken apart correctly. (The check has since gained a fourth read, the export on behalf of the user, and ran with four.) The configuration alone was about 530 KB.
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

## What the first write showed

The same day the owner ran `npm run live-check -- --write-only`. The server added one test rule through the administrator dialog, compared, and undid it. This was the first change made to a real Little Snitch.

What it confirmed:

- Little Snitch 6.5 takes a new rule as the server writes it. The rule came back with every field as sent, including the origin `frontend` and the note, and with nothing added.
- All other rules, several hundred, came back unchanged, both after the change and after the undo.
- The script that runs as root works under a real administrator dialog: the copy into root's folder, the checksum, the restore from the copy, and the read-back under the same approval.
- `--preserve-terminal-access` kept terminal access on.
- The check and the undo ran as designed. The check found differences, and the undo put the rules back.

What it corrected:

- A restore makes Little Snitch rewrite two sections by itself: `developerTeamNames` and `knownNEs`. Both are now on the list of sections Little Snitch owns.
- A restore writes the map position of the Network Monitor back under keys that start with a small letter. The volatile preference keys are now compared without regard to letter case.
- A restore run as plain root added a preferences record for the root user (uid 0) to the configuration. Under the administrator dialog nothing tells the tool for whom it acts. Every privileged command now carries `-u <uid>`, the tool's own option for that. The simulator does the same as the real tool: without `-u` it adds the record, and the strict check then fails.

Because of those three, the check reported a difference although the rules were right, and it reported the undo as unverified for the same reason. That was the strict check working as intended on a list that was too short.

## What the second write showed

After those fixes the owner ran `npm run live-check -- --write`. It passed: the test rule was added, the whole configuration compared equal to the intended one, the rule was removed, and the configuration compared equal again. Each change went through the administrator dialog and was read back under the same approval.

Before writing, the run exported the configuration twice under one approval, once with `-u <uid>` and once without. The server's comparison found them the same: the same rules, the same users, the same groups, profiles and preferences. That comparison leaves out the seven sections Little Snitch keeps for itself, so the run did not show whether those were identical too. The check now compares the two exports part by part as well and prints what differs.

One thing the run could not show. The record for the root user from the first attempt was still in the configuration, so the run does not tell whether `-u` keeps a restore from adding it.

## What the third write showed

After the third review's fixes the owner ran `npm run live-check -- --write` again (2026-11-23). It passed with the version in this repository: the lock for the whole Mac, the look at the list of running programs before each change, the check that the prompt can show the rule, and the new reading of the Security switches all ran on a real Little Snitch 6.5 without a false refusal.

What it added:

- Little Snitch writes the two Security switches as numbers. Both were on and read as "on". The earlier check, which refused only on an exact `false`, would never have refused on this Mac. That confirms the reviewers' finding. A switch that is off was not seen; the server takes it to be 0.
- The two exports, with and without `-u`, were identical in every part, the seven left-out sections included.
- Little Snitch rewrote `developerTeamNames` and `knownNEs` when the rule was added, and `knownNEs` when it was removed. The results named them.
- Rules also carry the fields `approved`, `owner`, `hidden` and `factoryHelpText`. The server shows them and does not interpret them. No rule had a remote field other than the four the server knows.

## Open questions

- Whether `-u <uid>` keeps a restore from adding a record for root. It is the documented purpose of the option, and a restore with it works, but the record already existed when the fix ran.
- Whether a restore changes anything else outside the rule list on its own. If it does, the change is undone and the error names the part or the preference key.
- Whether Little Snitch respells a rule in a way `tolerantKey` in `src/model/rules.ts` does not expect. For a simple host rule it does not.
- How `update_rule`, `restore_backup` and the two switch tools behave on a real Little Snitch. Only `add_rule` and `remove_rule` have run there.
- Which key holds the active profile, and what profiles look like.
- Whether macOS shows a prompt of about 1,000 characters whole in the administrator dialog.
- Whether a command started by the administrator dialog keeps running when `osascript` is killed. Without administrator rights it does. The server now assumes that it does.
- Whether such a command always shows in the list of running programs with the tool's path and its command, as it does for the processes this was tried with.
- What `knownNEs` and `developerTeamNames` hold, and whether `knownNEs` affects filtering.
- How Little Snitch writes the two Security switches when they are off, and whether every version writes them at all. On 6.5 they are numbers and were seen switched on. The server reads the common forms of yes and no.
- Whether two macOS users can share the lock file in practice. The file is readable by all, and `lockf` locks a file it can only read, but only one user was tried.
