# Tool reference

The server offers nine reading tools always, and six tools that change something only when the person allowed their kind. Your client may show the names with a prefix.

Reading tools may show a Touch ID or password prompt on the Mac, except `get_status`, `get_log` and `list_backups`, which need no root.

## Reading

### get_status

Says whether Little Snitch can be reached and what the server may do: the installed version, whether "Allow access via Terminal" is on, how root access is obtained, which kinds of change are allowed, whether changes need approval, Little Snitch's Security switches (on, off, unreadable or not-found), and a to-do list for the person. No inputs. Never shows a prompt.

### list_rules

Lists rules. Each rule has a `ref` that `update_rule` and `remove_rule` take. A ref changes when its rule changes.

- `process`: keep rules whose process path or helper contains this text, ignoring case.
- `remote`: keep rules whose remote (domain, host, address, or a keyword such as `local-net`) contains this text.
- `action`: `allow`, `deny`, `ask`, or `suggestion` (a rule Little Snitch proposes that is not in force).
- `direction`: `outgoing`, `incoming` or `both`.
- `group`: a rule group's id or name.
- `text`: matches process, remote, notes or group name.
- `unused_for_days`: rules not used for at least this many days, and rules never used.
- `sort`: `none` (Little Snitch's order, the default), `last_used`, `use_count`, `created` or `process`.
- `limit` (default 50) and `offset` for paging.

### list_rule_groups

Lists rule groups and blocklists, whether each is on, and how many rules each holds. A group named "unknown" is a built-in group the server has no name for. It can be listed but not switched. No inputs.

### list_profiles

Lists profiles and, when the configuration says so, which one is active. At most one profile is active. Rules that belong to no profile always apply. No inputs.

### get_traffic

Summarizes Little Snitch's traffic history: which apps talked to which hosts, how many connections, how many were denied, bytes in and out. The default is the last 60 minutes, grouped by app and host.

- `last_minutes`: the window ending now. Ignored when `from` is given.
- `from` and `to`: ISO 8601 with a time zone, for example `2026-11-22T09:00:00+04:00`.
- `app`: part of the executable path, ignoring case.
- `host`: part of a host name or IP address.
- `direction`: `in` or `out`.
- `denied_only`: only traffic with at least one denied connection.
- `group_by`: `app`, `host`, `app_and_host` (default) or `none` (the most recent raw rows).
- `sort_by`: `bytes` (default), `connections` or `denied`.
- `limit`: default 25.

### get_preferences

Lists Little Snitch's preference keys and values. Values whose key looks like a password, key or licence are hidden. The server cannot change preferences.

- `scope`: `all` (default), `global` or `user`.
- `contains`: keep keys containing this text.

### get_log

Reads Little Snitch's own recent log messages (its app, agent and network extension), newest last. For app traffic, use `get_traffic` instead.

- `minutes`: how far back, default 10.
- `contains`: keep messages containing this text.
- `limit`: default 50.

### list_backups

Lists the configuration backups this server saved, newest first. The server saves one before every change, and `create_backup` saves one on request. No inputs.

### create_backup

Saves the whole Little Snitch configuration to the server's data folder on the Mac. It changes nothing in Little Snitch and is always available.

- `label`: a short word for the file name, for example `before-cleanup`.

## Changing

Each of these exists only when the person allowed its kind with `--allow` or the plugin option. Each change is approved in the macOS administrator dialog unless the person switched that off. A backup is saved first. Afterwards the server reads the configuration back, compares every rule, rule group, profile and preference with what it intended, and undoes the change if anything differs.

### set_active_profile

Needs `switches`. Activates a profile by its exact name, or deactivates all profiles. A profile changes which rules apply, so a switch can loosen the firewall. No dry run.

- `profile` (required): the exact name as `list_profiles` shows it, or `null` to deactivate all profiles.

When the configuration does not show the active profile and nothing else changed, the result says "accepted", not "applied".

### set_rule_group_enabled

Needs `switches`. Switches a rule group or blocklist on or off. Switching one off stops its rules from applying. No dry run. Runs nothing when the group is already in that state.

- `group` (required): the id or exact name as `list_rule_groups` shows it.
- `enabled` (required): `true` or `false`.

### add_rule

Needs `rules`. Adds one rule that allows or denies connections of a process to a remote. The rule applies in all profiles, and its notes say it was added through MCP.

- `action` (required): `allow` or `deny`.
- `process` (required): the absolute path of the executable, or `any`.
- `via`: the absolute path of a helper; the rule then applies only through it.
- Exactly one remote:
  - `remote_domains`: each domain also covers its subdomains;
  - `remote_hosts`: exact host names;
  - `remote_addresses`: addresses, ranges (`a-b`) or networks (`a/prefix`);
  - `remote`: one keyword, `any`, `local-net`, `multicast`, `broadcast`, `bonjour`, `dns-servers` or `bpf`.
- `direction`: `outgoing` (default) or `incoming`.
- `ports`: `any` (default), one port such as `443`, or a range such as `8000-8100`.
- `protocol`: `tcp`, `udp` or `icmp`. Default: any.
- `priority`: `regular` (default) or `high`. A high-priority rule wins over regular ones.
- `notes`: one line saying why the rule exists.
- `dry_run`: when `true`, nothing changes and the result shows what would happen.

Refused: a rule for any process and any remote, and a remote list too long to show in the approval dialog.

### update_rule

Needs `rules`. Changes the action, priority or notes of one rule.

- `ref` (required): from `list_rules`.
- `action`, `priority`, `notes` (an empty text removes the notes).
- `dry_run`.

Refused: protected and factory rules, a rule the approval dialog could not show exactly, a change that would make the rule a copy of another rule, and a change to the action or priority of a rule for any process and any remote.

### remove_rule

Needs `rules`. Removes one rule. Removing a deny rule opens the firewall, and removing an allow rule can break an app.

- `ref` (required): from `list_rules`.
- `dry_run`.

Refused: protected and factory rules, and a rule the approval dialog could not show exactly. Such rules can still be changed in Little Snitch itself.

### restore_backup

Needs `restore`. Replaces the whole configuration (every rule, group, profile and setting) with a backup this server saved. Everything changed since that backup is lost. The current configuration is backed up first.

- `name` (required): the file name as `list_backups` shows it.
- `dry_run`: always run this first, and tell the person what would go and what would come back.
