import { LittleSnitchError } from './errors.js';
import { asNumber, asString, toPlain, type JsonObject, type JsonValue } from './model/json.js';
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

const REMOTE_KEYS: readonly string[] = ['remote', 'remote-domains', 'remote-hosts', 'remote-addresses'];
const MAX_SPECIAL_REMOTE = 40;
const MAX_REMOTE_VALUE = 253;
const MAX_ACTION = 20;
const MAX_PORTS = 40;
const MAX_PROTOCOL = 20;

/** A value written as text or as a number, as text. Anything else has no text. */
function textOf(value: JsonValue | undefined): string | undefined {
  const plain = value === undefined ? undefined : toPlain(value);
  return typeof plain === 'string' ? plain : typeof plain === 'number' ? String(plain) : undefined;
}

/** True when `shown` would print the text exactly as it is: nothing hidden, nothing cut, no space changed. */
const showsExactly = (text: string, max: number): boolean => shown(text, max) === text;

/**
 * Says why a rule cannot be shown exactly in an approval prompt, or nothing
 * when it can. Rules that are already in Little Snitch may hold anything, so
 * every field the prompt prints is checked: a field that would be left out,
 * cut, or printed differently from what the rule holds makes the rule one that
 * nobody could approve knowingly. A long process path is the one exception: it
 * is shown with its beginning and its end.
 */
export function unshowable(rule: JsonObject): string | undefined {
  const remoteKeys = Object.keys(rule).filter((key) => /^remote/i.test(key));
  const unknownKey = remoteKeys.find((key) => !REMOTE_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `a remote field this server does not know ("${shown(unknownKey, 40)}")`;
  }
  if (remoteKeys.length > 1) {
    return `more than one remote field (${remoteKeys.join(', ')})`;
  }
  for (const key of remoteKeys) {
    const value = rule[key];
    const entries = typeof value === 'string' ? [value] : Array.isArray(value) && key !== 'remote' ? value : undefined;
    if (entries === undefined || entries.length === 0 || !entries.every((entry): entry is string => typeof entry === 'string')) {
      return `a "${key}" value that is not text or a list of texts`;
    }
    if (!entries.every((entry) => entry !== '' && showsExactly(entry, key === 'remote' ? MAX_SPECIAL_REMOTE : MAX_REMOTE_VALUE))) {
      return `a "${key}" entry that is empty, too long, or holds hidden characters or unusual spaces`;
    }
  }
  for (const [key, max] of [['action', MAX_ACTION], ['ports', MAX_PORTS], ['protocol', MAX_PROTOCOL]] as const) {
    const text = textOf(rule[key]);
    if (rule[key] !== undefined && (text === undefined || !showsExactly(text, max))) {
      return `a "${key}" value that cannot be shown exactly`;
    }
  }
  if (rule['direction'] !== undefined && !['outgoing', 'incoming', 'both'].includes(asString(rule['direction']) ?? '')) {
    return 'a direction this server does not know';
  }
  if (rule['priority'] !== undefined && !['regular', 'high'].includes(asString(rule['priority']) ?? '')) {
    return 'a priority this server does not know';
  }
  for (const key of ['process', 'via'] as const) {
    const text = asString(rule[key]);
    if (rule[key] !== undefined && (text === undefined || hasHiddenCharacters(text))) {
      return `a "${key}" value that is not plain text`;
    }
  }
  if (rule['notes'] !== undefined && asString(rule['notes']) === undefined) {
    return 'notes that are not text';
  }
  return undefined;
}

/** The remote in words. `complete` is false when the list was too long to show whole. */
export function remoteText(rule: JsonObject): { readonly text: string; readonly complete: boolean } {
  const remote = remoteOf(rule);
  if (remote.kind === 'any') {
    return { text: 'ANY remote', complete: true };
  }
  if (remote.kind === 'special') {
    return { text: `the "${shown(remote.value, MAX_SPECIAL_REMOTE)}" remotes`, complete: showsExactly(remote.value, MAX_SPECIAL_REMOTE) };
  }
  if (remote.kind === 'unspecified') {
    return { text: 'an unspecified remote', complete: true };
  }
  const label = remote.kind === 'domains' ? 'the domains' : remote.kind === 'hosts' ? 'the hosts' : 'the addresses';
  const values = remote.values.map((value) => shown(value, MAX_REMOTE_VALUE));
  const whole = `${label} ${values.join(', ')}`;
  if (whole.length <= MAX_REMOTE_TEXT) {
    return { text: whole, complete: remote.values.every((value) => showsExactly(value, MAX_REMOTE_VALUE)) };
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

/**
 * One rule as a sentence fragment, action and remote first: "DENY connections to the domains x for /path/to/app".
 * A note is shown, and so is the rule's macOS user when it is not `viewerUid`, the user this server runs as.
 */
export function ruleText(rule: JsonObject, viewerUid?: number): string {
  const action = (asString(rule['action']) ?? 'unknown action').toUpperCase();
  const way = asString(rule['direction']);
  const direction = way === 'incoming' ? 'incoming connections from' : way === 'both' ? 'connections in both directions with' : 'connections to';
  const process = asString(rule['process']);
  const via = asString(rule['via']);
  const ports = textOf(rule['ports']);
  const protocol = textOf(rule['protocol']);
  const extras = [
    ...(ports === undefined || ports === 'any' ? [] : [`ports ${shown(ports, MAX_PORTS)}`]),
    ...(protocol === undefined ? [] : [`protocol ${shown(protocol, MAX_PROTOCOL)}`]),
    ...(asString(rule['priority']) === 'high' ? ['high priority'] : []),
  ];
  const notes = asString(rule['notes']);
  const uid = asNumber(rule['uid']);
  return (
    `${shown(action, MAX_ACTION)} ${direction} ${remoteText(rule).text} ` +
    `for ${process === 'any' ? 'ANY process' : process !== undefined ? shown(process) : rule['requiresTrustedSignatureForAnyProcess'] === true ? 'ANY process with a trusted signature' : 'an unspecified process'}` +
    (via === undefined ? '' : ` via ${shown(via)}`) +
    (extras.length === 0 ? '' : ` (${extras.join(', ')})`) +
    (uid === undefined || viewerUid === undefined || uid === viewerUid ? '' : `, a rule of macOS user ${uid}`) +
    (notes === undefined || notes === '' ? '' : `, with the note "${shown(notes, 120)}"`)
  );
}

/** What an update changes, in words, for the prompt and the change log. */
export function describeChanges(before: JsonObject, after: JsonObject): readonly string[] {
  const was = (key: string, fallback: string): string => asString(before[key]) ?? fallback;
  const now = (key: string, fallback: string): string => asString(after[key]) ?? fallback;
  return [
    ...(was('action', '') === now('action', '') ? [] : [`action ${shown(was('action', 'none'), 20).toUpperCase()} becomes ${shown(now('action', 'none'), 20).toUpperCase()}`]),
    ...(was('priority', 'regular') === now('priority', 'regular') ? [] : [`priority ${shown(was('priority', 'regular'), 20)} becomes ${shown(now('priority', 'regular'), 20)}`]),
    ...(was('notes', '') === now('notes', '') ? [] : [now('notes', '') === '' ? 'the note is removed' : 'the note changes']),
  ];
}

/**
 * Refuses a rule that cannot be shown whole and exactly in the approval
 * prompt: one whose remote list is too long, and one that holds data the
 * prompt would leave out, cut or print differently. This applies to a new rule
 * and to changing or removing an existing one: nobody can approve knowingly
 * what they cannot see.
 */
export function assertFitsPrompt(rule: JsonObject, existing: boolean = false): void {
  const elsewhere = existing ? 'Change or remove it in Little Snitch itself.' : 'Split it into several rules.';
  const reason = unshowable(rule);
  if (reason !== undefined) {
    throw new LittleSnitchError(
      'invalid-input',
      `This rule holds ${reason}, so an approval prompt could not show you exactly what the rule is. ${existing ? elsewhere : 'Give the rule in the form the tool describes.'}`,
    );
  }
  if (!remoteText(rule).complete) {
    throw new LittleSnitchError(
      'invalid-input',
      `This rule names more remotes than fit into one approval prompt (${MAX_REMOTE_TEXT} characters), so you could not see all of them before approving. ${elsewhere}`,
    );
  }
}

export const prompts = {
  add: (rule: JsonObject, viewerUid?: number): string => `Little Snitch MCP wants to ADD a firewall rule: ${ruleText(rule, viewerUid)}.`,
  remove: (rule: JsonObject, viewerUid?: number): string => `Little Snitch MCP wants to REMOVE a firewall rule: ${ruleText(rule, viewerUid)}.`,
  /** States what changes, and then the rule as it will be afterwards, so the last thing read is what is being approved. */
  update: (before: JsonObject, after: JsonObject, viewerUid?: number): string =>
    `Little Snitch MCP wants to CHANGE a firewall rule (${describeChanges(before, after).join('; ')}). After the change it will be: ${ruleText(after, viewerUid)}.`,
  restore: (name: string, removed: number, added: number, otherParts: number): string =>
    `Little Snitch MCP wants to REPLACE your whole Little Snitch configuration with the backup ${shown(name, 80)}: ` +
    `${removed} rule(s) would go, ${added} would come back` +
    (otherParts === 0 ? '.' : `, and ${otherParts} other part(s) such as preferences or groups would change.`),
  undo: 'Little Snitch MCP wants to UNDO a change that did not apply cleanly, by restoring the configuration from just before it.',
} as const;
