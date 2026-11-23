# Changelog

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
