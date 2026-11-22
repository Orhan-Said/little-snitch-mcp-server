import { LittleSnitchError } from './errors.js';
import { asString, type JsonObject } from './model/json.js';
import { remoteOf } from './model/rules.js';

/**
 * The text of an approval prompt is the only thing the person sees before they
 * approve a change. It is built here from the rule's fields, so that what
 * matters most, the action and the remote, always comes first and in full.
 * No field is ever cut off at the end.
 */

/** Control and formatting characters, including the ones that reorder or hide text on screen. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HIDDEN_CHARACTERS_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The remote of a rule must fit into the prompt completely, or the rule cannot be approved knowingly. */
export const MAX_REMOTE_TEXT = 400;
const MAX_PATH_TEXT = 160;

export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_CHARACTERS.test(text);
}

/**
 * Makes a text safe to show: a hidden character becomes "?", and a long text
 * keeps its beginning and its end with " ... " in between, so that both the
 * folder an app lives in and the program's name stay visible.
 */
export function shown(text: string, max: number = MAX_PATH_TEXT): string {
  const clean = text.replace(HIDDEN_CHARACTERS_ALL, '?').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  const head = Math.ceil((max - 5) * 0.45);
  const tail = max - 5 - head;
  return `${clean.slice(0, head)} ... ${clean.slice(-tail)}`;
}

/** The remote in words. `complete` is false when the list was too long to show whole. */
export function remoteText(rule: JsonObject): { readonly text: string; readonly complete: boolean } {
  const remote = remoteOf(rule);
  if (remote.kind === 'any') {
    return { text: 'ANY remote', complete: true };
  }
  if (remote.kind === 'special') {
    return { text: `the "${shown(remote.value, 40)}" remotes`, complete: true };
  }
  if (remote.kind === 'unspecified') {
    return { text: 'an unspecified remote', complete: true };
  }
  const label = remote.kind === 'domains' ? 'the domains' : remote.kind === 'hosts' ? 'the hosts' : 'the addresses';
  const values = remote.values.map((value) => shown(value, 253));
  const whole = `${label} ${values.join(', ')}`;
  if (whole.length <= MAX_REMOTE_TEXT) {
    return { text: whole, complete: true };
  }
  const fitting: string[] = [];
  for (const value of values) {
    if (`${label} ${[...fitting, value].join(', ')}`.length > MAX_REMOTE_TEXT - 30) {
      break;
    }
    fitting.push(value);
  }
  return { text: `${label} ${fitting.join(', ')} and ${values.length - fitting.length} more`, complete: false };
}

/** One rule as a sentence fragment, action and remote first: "DENY connections to the domains x for /path/to/app". */
export function ruleText(rule: JsonObject): string {
  const action = (asString(rule['action']) ?? 'unknown action').toUpperCase();
  const direction = asString(rule['direction']) === 'incoming' ? 'incoming connections from' : 'connections to';
  const process = asString(rule['process']);
  const via = asString(rule['via']);
  const ports = asString(rule['ports']);
  const protocol = asString(rule['protocol']);
  const extras = [
    ...(ports === undefined || ports === 'any' ? [] : [`ports ${shown(ports, 20)}`]),
    ...(protocol === undefined ? [] : [`protocol ${shown(protocol, 20)}`]),
    ...(asString(rule['priority']) === 'high' ? ['high priority'] : []),
  ];
  return (
    `${shown(action, 20)} ${direction} ${remoteText(rule).text} ` +
    `for ${process === 'any' ? 'ANY process' : process === undefined ? 'an unspecified process' : shown(process)}` +
    (via === undefined ? '' : ` via ${shown(via)}`) +
    (extras.length === 0 ? '' : ` (${extras.join(', ')})`)
  );
}

/** Refuses a new rule whose remote list is too long to show whole in the approval prompt. */
export function assertFitsPrompt(rule: JsonObject): void {
  if (!remoteText(rule).complete) {
    throw new LittleSnitchError(
      'invalid-input',
      `This rule names more remotes than fit into one approval prompt (${MAX_REMOTE_TEXT} characters), so you could not see all of them before approving. Split it into several rules.`,
    );
  }
}

export const prompts = {
  add: (rule: JsonObject): string => `Little Snitch MCP wants to ADD a firewall rule: ${ruleText(rule)}.`,
  remove: (rule: JsonObject): string => `Little Snitch MCP wants to REMOVE a firewall rule: ${ruleText(rule)}.`,
  update: (before: JsonObject, changes: readonly string[]): string =>
    `Little Snitch MCP wants to CHANGE a firewall rule (${changes.join('; ')}). The rule now: ${ruleText(before)}.`,
  restore: (name: string, removed: number, added: number, otherParts: number): string =>
    `Little Snitch MCP wants to REPLACE your whole Little Snitch configuration with the backup ${shown(name, 80)}: ` +
    `${removed} rule(s) would go, ${added} would come back` +
    (otherParts === 0 ? '.' : `, and ${otherParts} other part(s) such as preferences or groups would change.`),
  undo: 'Little Snitch MCP wants to UNDO a change that did not apply cleanly, by restoring the configuration from just before it.',
} as const;
