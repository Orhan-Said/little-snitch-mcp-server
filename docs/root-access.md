# Root access

`littlesnitch`, the command-line tool inside Little Snitch, refuses almost every command unless it runs as root. On Little Snitch 6.5 it prints `littlesnitch must be run as root!` and exits with code 14. Only `--version`, `log` and `restrictions` work without root. The server uses `restrictions` to tell whether "Allow access via Terminal" is on: with the setting off it prints "command line tool is not authorized" and exits with 1, with the setting on it exits with 0. Both were seen on Little Snitch 6.5.

An MCP client starts this server without a terminal. `sudo` then has nowhere to ask for a password and fails with `sudo: a terminal is required to read the password`. The server needs another way to get your approval.

## Reading and changing are treated differently

For a read, any way to root is fine, and the quietest one wins: `sudo` without a prompt, then Touch ID through `sudo`, then the administrator dialog.

For a change, the server uses the administrator dialog and nothing else. The reason is that `sudo` cannot promise a prompt. If a `NOPASSWD` rule in `sudoers` matches, `sudo` runs the command and asks nobody, and the server has no way to see that rule in advance. The dialog asks every time.

You can switch this off with `--unattended-writes`. Changes then take the same route as reads. With `--elevation dialog` the flag has no effect, because that mode uses the dialog for everything.

## The modes

| `--elevation` | Reads | Changes |
|---|---|---|
| `auto` (default) | `sudo` without a prompt, else Touch ID through `sudo`, else the administrator dialog | The administrator dialog |
| `sudo` | `sudo` without a prompt, else Touch ID through `sudo`. Never the dialog. | Refused, unless `--unattended-writes` is on |
| `dialog` | The administrator dialog | The administrator dialog, also with `--unattended-writes` |
| `none` | The tool is run directly. Works only when the server itself runs as root. | The same, with no approval at all. Meant for the tests. |

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

macOS may remember an approval for a few minutes, so that several reads in a row need one touch.

Touch ID for sudo makes reading comfortable. It does not replace the administrator dialog for changes. If Touch ID does not work, for example with the lid closed, the server falls back to the dialog in `auto` mode.

A Mac without a fingerprint reader cannot use this. The administrator dialog covers reads as well.

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

A rule change or a switch needs one prompt for the change. Without Touch ID for sudo it needs a second one before that, to read the current configuration.

If you do not answer the dialog within five minutes, the server gives up. It cannot tell whether the command was started, and it cannot stop a command that runs as root. So it starts nothing further and reports that the state is not known.

The command string is the only place where the server builds shell text. It single-quotes every word and passes the string to AppleScript as an argument, so it never becomes part of the AppleScript source. `tests/cli/shell.test.ts` runs the generated strings through `/bin/sh` with quotes, spaces, line breaks and shell syntax in the arguments.

### The private copy

A changed configuration is a file in the server's data folder, which your own programs can write to. If root read it from there, another program could swap it after you approved. So for a restore, the script that runs as root does this:

1. It makes a folder with `mktemp -d` inside `/private/var/root`, root's home folder. `mktemp` gives the new folder mode 700, so only root can enter it.
2. It copies the file into that folder.
3. It computes the SHA-256 of the copy with `/usr/bin/shasum` and compares it with the checksum the server noted when it wrote the file.
4. If they match, it has Little Snitch restore the copy. If not, it prints an error, exits with code 97 and runs nothing.
5. It removes the folder.

The tests run this script with `/bin/sh` and a temporary folder in place of `/private/var/root`: a matching file, a swapped file, a missing file and a tool that fails.

## Why there is no sudoers recipe here

A line such as this in `/etc/sudoers.d/` would remove every prompt:

```
%admin ALL = (root) NOPASSWD: /Applications/Little Snitch.app/Contents/Components/littlesnitch
```

Do not add it. It weakens your Mac in three ways:

- Every program you run could then change your firewall without asking. `restore-model` replaces all rules.
- `littlesnitch export-model <file>` writes its output to any path as root. A program could overwrite system files with it.
- `/Applications` is writable by the `admin` group. A program running as an administrator could put its own file at that path and have `sudo` run it as root.

The server does use `sudo` without a prompt for reading when your system allows it, because it tries that first. `get_status` tells you when that is the case. Changes still go through the administrator dialog, unless you switched on `--unattended-writes`.

If you decide to write your own rule, allow exact command lines such as `littlesnitch export-model` with no further arguments, never the whole tool. This project does not ship or test such a rule.

## What the server checks before it uses root

Before each privileged run, unless the mode is `none`:

1. The tool at the configured path exists and is a regular file.
2. Its owner is root.
3. Neither its group nor other users can write to it.
4. The path is not a symbolic link.
5. `codesign --verify --strict` accepts it against the requirement `identifier "littlesnitch" and anchor apple generic and certificate leaf[subject.OU] = "MLZF7K7B5R"`. That is Objective Development's Apple developer team.

The server repeats the signature check when the file's inode, size or modification time changes. There is still a short moment between the check and the run in which the file could be swapped. The check raises the cost of that attack. It does not rule it out.
