/**
 * Every failure a tool can report. `kind` is stable and machine-readable;
 * `remedy` tells the person at the Mac what to do, in their words.
 */
export type ErrorKind =
  | 'not-installed'
  | 'untrusted-binary'
  | 'terminal-access-disabled'
  | 'needs-root'
  | 'elevation-unavailable'
  | 'elevation-cancelled'
  | 'elevation-failed'
  | 'cli-failed'
  | 'timeout'
  | 'capability-disabled'
  | 'invalid-input'
  | 'not-found'
  | 'ambiguous'
  | 'protected'
  | 'unexpected-output'
  | 'busy'
  | 'tampered'
  | 'verification-failed';

export interface ErrorDetails {
  readonly [key: string]: unknown;
}

export class LittleSnitchError extends Error {
  readonly kind: ErrorKind;
  readonly remedy: string | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(kind: ErrorKind, message: string, options: { remedy?: string; details?: ErrorDetails } = {}) {
    super(message);
    this.name = 'LittleSnitchError';
    this.kind = kind;
    this.remedy = options.remedy;
    this.details = options.details;
  }
}

export const TERMINAL_ACCESS_REMEDY =
  'Open Little Snitch, choose Settings > Security, and switch on "Allow access via Terminal". ' +
  'Little Snitch keeps this off by default because the command-line tool can change the firewall.';

export const ELEVATION_REMEDY =
  "Little Snitch's command-line tool only works as root. Pick one: " +
  '(1) Touch ID for sudo: run `sudo cp /etc/pam.d/sudo_local.template /etc/pam.d/sudo_local`, then ' +
  'uncomment the pam_tid.so line in /etc/pam.d/sudo_local; ' +
  '(2) start this server with elevation "auto" (the default) or "dialog", so it can show the macOS administrator password dialog. ' +
  'docs/root-access.md in the repository explains both.';

export function toErrorPayload(error: unknown): { kind: string; message: string; remedy?: string; details?: ErrorDetails } {
  if (error instanceof LittleSnitchError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'internal', message };
}
