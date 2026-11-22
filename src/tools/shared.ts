import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toErrorPayload } from '../errors.js';

/** A reused configuration may be this old for a read that only lists things. */
export const READ_CACHE_MS = 15_000;
/** Resolving a profile or group name may use an older copy: Little Snitch itself rejects a name that no longer exists. */
export const NAME_CACHE_MS = 10 * 60_000;

export function respond(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/** Wraps a tool so that every failure comes back as a readable error with its remedy, never as a thrown exception. */
export function safely<Args>(handler: (args: Args) => Promise<unknown>): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return respond(await handler(args));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: toErrorPayload(error) }, null, 2) }] };
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
