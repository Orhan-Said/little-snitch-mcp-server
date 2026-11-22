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

The server uses the third. It tries `sudo` without a prompt first, then Touch ID, then the dialog. A change never takes the first step, so it always gets a fresh approval unless the owner switched that off.

### How to change a rule

1. Write `.lsrules` files. The format is documented, but Little Snitch 6 only subscribes to them over HTTPS with a valid certificate, through its own window. A local server cannot do that.
2. Script the Little Snitch window. Brittle, and it needs Accessibility permission for the assistant's host.
3. Export, edit and restore the configuration. This is the documented route. Its risk is that a restore replaces everything.

The server uses the third and surrounds it with checks: a backup before, a read-back after, a comparison of every rule, and an automatic restore of the backup when the comparison fails.

### How to hold the configuration in memory

The format is undocumented and changes between versions. Typed structures with every field named would break on the next release, which is what happened to the earlier project. The server instead treats the configuration as loose JSON:

- It reads only the fields it needs and passes everything else through untouched.
- It parses numbers losslessly, so a 64-bit value or a number written as `1.0` goes back exactly as it came.
- It reads dates in three forms (ISO text, seconds from 2001, seconds from 1970) and writes a new date in the form the other rules use.
- It shows fields it does not interpret under `other`, so nothing is hidden.

### How to identify a rule

Rules carry no id in the configuration. The server derives a reference from a hash of the rule's content, leaving out the two fields Little Snitch updates on its own (`lastUsed`, `useCount`). A reference therefore stops matching when the rule changes, which protects against editing a rule that is no longer what the assistant saw.

After a change, the server matches the new rule by meaning, not by exact text: action, process, helper, remote, direction, ports, protocol and priority, with defaults filled in. Little Snitch may respell a rule it accepts, for example turn `tcp` into `6`, and that must not count as a failure.

### What the assistant may do by default

Nothing but read. The owner names the kinds of change at startup. A tool that is not allowed is not registered, so it does not appear in the assistant's tool list and cannot be called.

## What is left out of the first release

- Preferences cannot be changed. One preference switches terminal access off, and others stop the filter. A safe list of keys needs testing on a real install first.
- A rule cannot be placed in a profile or created disabled. The field names are not confirmed.
- Packet capture (`capture-traffic`) and live streams. They run until stopped and return payload data.
- Subscribing to blocklists and answering connection alerts. The command-line tool cannot do either.

## Open questions

These need a run on a real install with terminal access on. `npm run live-check` prints the answers without any personal data.

- Which key holds the active profile.
- What `restrictions` prints when terminal access is on.
- The exact CSV that `log-traffic` prints on 6.5.
- Whether the rule shape from 6.3.3 is still accepted by `restore-model` on 6.5. `npm run live-check -- --write` tests it with one harmless rule.
