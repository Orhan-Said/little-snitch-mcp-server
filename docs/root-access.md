# Root access

`littlesnitch`, the command-line tool inside Little Snitch, refuses almost every command unless it runs as root. On Little Snitch 6.5 it prints `littlesnitch must be run as root!` and exits with code 14. Only `--version`, `log` and the check for "Allow access via Terminal" work without root.

An MCP client starts this server without a terminal. `sudo` then has nowhere to ask for a password and fails with `sudo: a terminal is required to read the password`. The server needs another way to get your approval. It has two, and you choose with `--elevation`.

## The modes

| `--elevation` | What happens when root is needed |
|---|---|
| `auto` (default) | The server first tries `sudo` without a prompt. If `sudo` wants a password and Touch ID for sudo is set up, macOS asks for your fingerprint. Otherwise the server opens the macOS administrator dialog. |
| `sudo` | Like `auto`, but the server never opens the administrator dialog. Without Touch ID for sudo, privileged tools fail with an explanation. |
| `dialog` | The server always opens the administrator dialog, for reads too. |
| `none` | The server runs the tool directly. This works only when the server itself runs as root, and it is what the tests use. |

## Touch ID for sudo

macOS ships a template for this. Run these two commands in Terminal:

```bash
sudo cp /etc/pam.d/sudo_local.template /etc/pam.d/sudo_local
```

```bash
sudo sed -i '' 's/^#auth/auth/' /etc/pam.d/sudo_local
```

The second command removes the `#` in front of the `pam_tid.so` line. macOS keeps `/etc/pam.d/sudo_local` across system updates.

After that, `sudo` asks for your fingerprint, also when a program without a terminal runs it. The torsday/little-snitch-mcp project tested exactly that case in April 2026. This project has not run it yet: the command lines the server builds for `sudo` are tested, the fingerprint prompt is not.

macOS may remember an approval for a few minutes, so that several reads in a row need one touch. For a change, the server calls `sudo -k`, which makes `sudo` ignore a remembered approval. Each change gets its own prompt unless you start the server with `--unattended-writes`.

A Mac without a fingerprint reader cannot use this. Use the administrator dialog.

## The administrator dialog

With `auto` or `dialog`, the server runs this AppleScript through `/usr/bin/osascript`:

```applescript
on run argv
  do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings
end run
```

macOS shows its standard password dialog. The prompt text says what the server wants to do, for example `Little Snitch MCP wants to activate the Little Snitch profile "Work".` You type your password into the macOS dialog. The server gets the command's output and never the password.

macOS asks again for every call. To keep the number of prompts down, the server does two things:

- It runs a change and the read-back that checks it under one dialog.
- It reuses the configuration it read for 15 seconds, so listing rules, groups and profiles in a row needs one prompt.

A rule change still needs two prompts: one to read the current configuration and one to apply the change.

The command string is the only place where the server builds shell text. It single-quotes every word and passes the string to AppleScript as an argument, so it never becomes part of the AppleScript source. `tests/cli/shell.test.ts` runs the generated strings through `/bin/sh` with quotes, spaces and shell characters in the arguments.

## Why there is no sudoers recipe here

A line such as this in `/etc/sudoers.d/` would remove every prompt:

```
%admin ALL = (root) NOPASSWD: /Applications/Little Snitch.app/Contents/Components/littlesnitch
```

Do not add it. It weakens your Mac in three ways:

- Every program you run could then change your firewall without asking. `restore-model` replaces all rules.
- `littlesnitch export-model <file>` writes its output to any path as root. A program could overwrite system files with it.
- `/Applications` is writable by the `admin` group. A program running as an administrator could put its own file at that path and have `sudo` run it as root.

The server does use `sudo` without a prompt when your system allows it, because it tries that first. If you decide to write your own rule, allow exact command lines such as `littlesnitch export-model` with no further arguments, never the whole tool. This project does not ship or test such a rule.

## What the server checks before it uses root

Before each privileged run, unless the mode is `none`:

1. The tool at the configured path exists and is a regular file.
2. Its owner is root.
3. Neither its group nor other users can write to it.
4. `codesign --verify --strict` accepts it against the requirement `identifier "littlesnitch" and anchor apple generic and certificate leaf[subject.OU] = "MLZF7K7B5R"`. That is Objective Development's Apple developer team.

The server repeats the signature check when the file's inode, size or modification time changes. There is still a short moment between the check and the run in which the file could be swapped. The check raises the cost of that attack. It does not rule it out.
