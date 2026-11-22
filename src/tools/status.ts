import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '../context.js';
import { ELEVATION_REMEDY, TERMINAL_ACCESS_REMEDY } from '../errors.js';
import { READ_ONLY, safely } from './shared.js';

const TOUCH_ID_TIP =
  'Optional: set up Touch ID for sudo, so reading needs a touch instead of a password dialog. Changes still use the password dialog. ' +
  'Run `sudo cp /etc/pam.d/sudo_local.template /etc/pam.d/sudo_local`, then uncomment the pam_tid.so line in /etc/pam.d/sudo_local.';

/** Collects everything a person needs to see to get the server working. Never asks for approval. */
export async function readStatus(ctx: Context): Promise<unknown> {
  const { config } = ctx;
  const binary = await ctx.binary.inspect(config.elevation !== 'none');
  // Ownership and signature only matter when the tool is about to be run as root on the person's behalf.
  const problems = config.elevation === 'none' ? [] : binary.problems;
  const trusted = binary.exists && problems.length === 0;
  const attempt = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch {
      return fallback;
    }
  };
  const version = binary.exists ? await attempt(() => ctx.cli.version(), null) : null;
  const terminalAccess = binary.exists ? await attempt(() => ctx.cli.terminalAccess(), 'unknown' as const) : 'unknown';
  const touchId = await ctx.touchId();
  const sudoSilent = config.elevation !== 'none' && config.elevation !== 'dialog' && trusted ? await attempt(() => ctx.cli.sudoWithoutPrompt(), false) : false;
  const dialogAvailable = config.elevation === 'auto' || config.elevation === 'dialog';

  const readApproval =
    config.elevation === 'none'
      ? 'none: the tool is run directly, so this server must itself run as root'
      : config.elevation === 'dialog'
        ? 'the macOS administrator password dialog, for each read'
        : sudoSilent
          ? 'none: sudo runs the tool without asking'
          : touchId
            ? 'Touch ID (macOS may not ask again for a few minutes)'
            : dialogAvailable
              ? 'the macOS administrator password dialog, for each read'
              : 'not possible yet: sudo needs a password and Touch ID for sudo is not set up';
  // A change that needs approval always goes through the administrator dialog: it is the one prompt a sudoers rule cannot switch off.
  const changeApproval =
    config.allow.size === 0
      ? 'not applicable: this server is read-only'
      : config.elevation === 'none'
        ? 'NONE: with elevation "none" the tool is run directly and nobody is asked'
        : !config.unattendedWrites
          ? dialogAvailable
            ? 'the macOS administrator password dialog, for each change'
            : 'not possible: elevation "sudo" cannot make sure each change is approved; use "auto" or "dialog", or switch on unattended writes'
          : sudoSilent
            ? 'NONE: unattended writes are switched on and sudo runs the tool without asking'
            : touchId && config.elevation !== 'dialog'
              ? 'unattended writes are switched on: Touch ID, or no prompt at all while an earlier approval is still remembered'
              : dialogAvailable
                ? 'the macOS administrator password dialog (unattended writes are switched on, but sudo needs a password)'
                : 'not possible yet: sudo needs a password and Touch ID for sudo is not set up';

  const toDo = [
    ...(binary.exists ? [] : ['Install Little Snitch 6 from https://obdev.at/littlesnitch.']),
    ...(binary.exists ? problems : []),
    ...(terminalAccess === 'disabled' ? [TERMINAL_ACCESS_REMEDY] : []),
    ...(config.elevation === 'sudo' && !sudoSilent && !touchId ? [ELEVATION_REMEDY] : []),
    ...(config.elevation === 'auto' && !sudoSilent && !touchId ? [TOUCH_ID_TIP] : []),
    ...(sudoSilent
      ? ['On this Mac sudo runs the Little Snitch tool without asking (a NOPASSWD rule or a remembered approval). Reads need no approval. Any program you run can use that rule too; see docs/root-access.md.']
      : []),
    ...(config.elevation === 'none' && config.allow.size > 0
      ? ['Elevation "none" is meant for tests: the assistant can make the allowed changes without anyone approving them.']
      : []),
    ...(config.allow.size === 0
      ? ['This server only reads. To let the assistant make changes, start it with --allow switches, --allow rules, --allow restore, or a comma-separated list.']
      : []),
  ];

  return {
    littleSnitch: {
      installed: binary.exists,
      version,
      cliPath: config.cliPath,
      signature:
        binary.signedByObjectiveDevelopment === null ? 'not checked' : binary.signedByObjectiveDevelopment ? 'valid (Objective Development)' : 'INVALID',
    },
    terminalAccess,
    rootAccess: {
      mode: config.elevation,
      sudoRunsWithoutAsking: sudoSilent,
      touchIdForSudo: touchId,
      approvalForReads: readApproval,
      approvalForChanges: changeApproval,
    },
    changesAllowed: [...config.allow].sort(),
    dataFolder: config.dataDir,
    backups: (await ctx.store.listBackups()).length,
    toDo,
  };
}

export function registerStatusTool(server: McpServer, ctx: Context): void {
  server.registerTool(
    'get_status',
    {
      title: 'Little Snitch status',
      description:
        'Check whether Little Snitch can be reached and what this server may do: installed version, whether "Allow access via Terminal" is on, ' +
        'how root access is obtained, which kinds of changes are allowed, and a to-do list for the person when something is missing. ' +
        'Never shows an approval prompt. Call this first, and again whenever another tool reports a setup problem.',
      inputSchema: {},
      annotations: { ...READ_ONLY, title: 'Little Snitch status' },
    },
    safely(() => readStatus(ctx)),
  );
}
