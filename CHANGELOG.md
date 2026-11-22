# Changelog

## 0.1.0 (not released yet)

First version.

- Nine reading tools: status, rules, rule groups, profiles, traffic history, preferences, Little Snitch's log, and backups.
- Six tools that change something, each off until allowed with `--allow`: switch profile, switch rule group, add rule, change rule, remove rule, restore backup.
- Root access through `sudo`, Touch ID for sudo, or the macOS administrator dialog.
- A backup before each rule change, a read-back after it, and an automatic restore when the result is not what was intended.
- `npm run live-check` to test the server against the Little Snitch on your own Mac.

Checked on Little Snitch 6.5 and macOS 26.6 as far as that is possible without root. The README lists what was tested how.
