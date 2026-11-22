/**
 * The one place a shell is involved: the macOS administrator dialog
 * (`do shell script ... with administrator privileges`) only accepts a shell
 * string. Every word is single-quoted here, and the string is handed to
 * AppleScript as an argument, never pasted into AppleScript source.
 */

export interface StepOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function shellQuote(word: string): string {
  if (word.includes('\0')) {
    throw new Error('A command word must not contain a NUL byte.');
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds one shell string that runs each command in turn and stops at the
 * first failure. After each command it prints a marker line with the exit
 * code, then what the command wrote to stderr, then an end marker, so the
 * caller can take the commands' output apart again.
 */
export function buildCompoundScript(program: string, steps: readonly (readonly string[])[], token: string): string {
  if (!/^[A-Za-z0-9]{16,}$/.test(token)) {
    throw new Error('The marker token must be at least 16 letters or digits.');
  }
  const quotedToken = shellQuote(token);
  const quotedEnd = shellQuote(`${token}-end`);
  return steps
    .map((args) => {
      const command = [program, ...args].map(shellQuote).join(' ');
      return (
        `{ e=$(${command} 2>&1 1>&3); rc=$?; } 3>&1; ` +
        `printf '\\n%s %s\\n%s\\n%s\\n' ${quotedToken} "$rc" "$e" ${quotedEnd}; ` +
        `[ "$rc" -eq 0 ] || exit 0`
      );
    })
    .join('; ');
}

/** Takes the output of {@link buildCompoundScript} apart. Returns one entry per command that ran. */
export function parseCompoundOutput(output: string, token: string): readonly StepOutput[] {
  const steps: StepOutput[] = [];
  const startMarker = `\n${token} `;
  const endMarker = `\n${token}-end\n`;
  let rest = output;
  for (;;) {
    const start = rest.indexOf(startMarker);
    if (start === -1) {
      return steps;
    }
    const stdout = rest.slice(0, start);
    const afterStart = rest.slice(start + startMarker.length);
    const lineEnd = afterStart.indexOf('\n');
    const end = afterStart.indexOf(endMarker, Math.max(lineEnd, 0));
    if (lineEnd === -1 || end === -1) {
      return steps;
    }
    const code = Number.parseInt(afterStart.slice(0, lineEnd), 10);
    if (!Number.isInteger(code)) {
      return steps;
    }
    const stderr = afterStart.slice(lineEnd + 1, end);
    steps.push({ code, stdout, stderr });
    rest = afterStart.slice(end + endMarker.length);
  }
}

/** The AppleScript that shows the administrator dialog. The command and the prompt arrive as arguments. */
export const ADMIN_DIALOG_SCRIPT: readonly string[] = [
  'on run argv',
  'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings',
  'end run',
];

export function adminDialogArgs(script: string, prompt: string): readonly string[] {
  return [...ADMIN_DIALOG_SCRIPT.flatMap((line) => ['-e', line]), '--', script, prompt];
}
