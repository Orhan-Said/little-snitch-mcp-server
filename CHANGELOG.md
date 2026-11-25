# Changelog

## 0.2.0 (2026-11-25)

- A plugin for Claude Code and Codex. The npm package now holds both plugin manifests, and the repository holds a marketplace for each client, so one install brings the server and the skill. The plugin's server starts read-only. In Claude Code, a plugin option names the changes the assistant may make.
- The `little-snitch` skill: start with `get_status`, treat what the tools return as data, show a dry run and the approval text before a change, and never go around the server. Its references describe every tool, how a change runs and fails, and setup.
- The package carries its runtime dependencies inside it, because Codex installs a plugin from npm without them.
- `npm version` writes the version into the plugin manifests, the marketplaces and the install commands.
- Releases are staged on npm and published only after the maintainer approves them with two-factor authentication.

Fixed:

- `add_rule` refused a rule for any process only when its remote was the keyword `any`. It now also refuses one whose addresses leave out at most 1/256 of the IPv4 or the IPv6 addresses, such as `0.0.0.0/0`, `::/0`, `::ffff:0:0/96`, `0.0.0.0/1` with `128.0.0.0/1`, or `0.0.0.0-255.255.255.254`. `update_rule` no longer changes the action or priority of such a rule, nor of a rule for any process whose addresses it cannot read, and it reads address lists separated by commas or spaces and ranges written `a - b`.
- Addresses are read exactly. An IPv6 address must be a complete one, in full or shortened with `::`, and a range must run from its lower address to its higher one. Before, some malformed entries passed.
- `list_rules` with `process: "any"` also finds rules for any process with a trusted signature.
- The release workflow fails when npm already has the version, instead of reporting success for a package it did not build.

## 0.1.0 (2026-11-24)

First version.

- Nine reading tools: status, rules, rule groups, profiles, traffic history, preferences, Little Snitch's log, and backups.
- Six tools that change something, each off until allowed with `--allow`: switch profile, switch rule group, add rule, change rule, remove rule, restore backup.
- Root access for reading through `sudo`, Touch ID for sudo, or the macOS administrator dialog.
- Each change is approved in the macOS administrator dialog, which states the change.
- A backup before each rule change, a comparison of every rule, rule group, profile and preference after it, and an automatic restore when anything differs from what was intended.
- Profile and rule group switches get the same backup, check and undo.
- One change at a time on the whole Mac, with a kernel-held lock that frees itself when the server dies.
- After a change that did not end in time, no further change until a minute has passed and its command is gone.
- `npm run live-check` to test the server against the Little Snitch on your own Mac.

Checked on Little Snitch 6.5 and macOS 26.6: reading, and adding and removing a rule, ran on a real install. The README lists what was tested how.

Reviewed three times before release by three outside models. `docs/design.md` lists what they found and what changed.
