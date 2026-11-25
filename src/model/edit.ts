import path from 'node:path';
import { LittleSnitchError } from '../errors.js';
import { catchAllFamilies, parseAddressSpan } from './addresses.js';
import { detectEncoding, encodeDate, type DateEncoding } from './dates.js';
import { asBoolean, asString, isObject, numberValue, rawRules, rulesOf, type JsonObject, type JsonValue } from './json.js';
import { ruleRef } from './rules.js';

export const SPECIAL_REMOTES = ['any', 'local-net', 'multicast', 'broadcast', 'bonjour', 'dns-servers', 'bpf'] as const;
export type SpecialRemote = (typeof SPECIAL_REMOTES)[number];

export interface NewRuleSpec {
  readonly action: 'allow' | 'deny';
  /** An absolute path to an executable, or "any". */
  readonly process: string;
  readonly via?: string;
  readonly remoteDomains?: readonly string[];
  readonly remoteHosts?: readonly string[];
  readonly remoteAddresses?: readonly string[];
  readonly remote?: SpecialRemote;
  readonly direction?: 'outgoing' | 'incoming';
  readonly ports?: string;
  readonly protocol?: 'tcp' | 'udp' | 'icmp';
  readonly priority?: 'regular' | 'high';
  readonly notes?: string;
}

export interface RulePatch {
  readonly action?: 'allow' | 'deny';
  readonly priority?: 'regular' | 'high';
  readonly notes?: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/** Control and formatting characters. In a path or a note they can hide or reorder what an approval prompt shows. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const invalid = (message: string): LittleSnitchError => new LittleSnitchError('invalid-input', message);

const CATCH_ALL =
  'A rule for any process and any remote would switch the firewall off (allow) or cut the Mac off from the network (deny).';

function assertPlainNotes(notes: string): void {
  if (notes.length > 500 || HIDDEN.test(notes)) {
    throw invalid('Notes must be at most 500 characters on one line, without control or invisible characters.');
  }
}

function assertExecutablePath(kind: string, value: string): void {
  if (!path.isAbsolute(value) || HIDDEN.test(value) || value.length > 1024) {
    throw invalid(`The ${kind} must be an absolute path to an executable, such as /Applications/Safari.app/Contents/MacOS/Safari.`);
  }
  if (value.endsWith('.app') || value.endsWith('.app/')) {
    throw invalid(`The ${kind} must be the executable inside the app, for example ${value.replace(/\/$/, '')}/Contents/MacOS/<name>, not the .app folder.`);
  }
}

/**
 * An address list as Little Snitch may keep it: one text, a list of texts, or
 * a text of entries separated by commas or spaces, with ranges written "a - b"
 * as its help shows them.
 */
function addressEntries(value: JsonValue | undefined): readonly string[] {
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return texts
    .map((text) => text.replace(/\s*-\s*/g, '-').replace(/\s*\/\s*/g, '/'))
    .flatMap((text) => text.split(/[\s,]+/))
    .filter((entry) => entry !== '');
}

/** The sentence that says why an address list is a catch-all, or undefined when it is not one. */
function wholeFamilySentence(entries: readonly string[]): string | undefined {
  const [family] = catchAllFamilies(entries);
  return family === undefined ? undefined : `A list that covers all or nearly all ${family} addresses counts as any remote.`;
}

/**
 * Why an existing rule counts as a rule for every process and every remote,
 * or undefined when it does not. A rule for any process whose addresses the
 * server cannot all read counts too: it cannot tell what that rule covers.
 */
function catchAllReason(rule: JsonObject): string | undefined {
  const anyProcess = asString(rule['process']) === 'any' || (rule['process'] === undefined && asBoolean(rule['requiresTrustedSignatureForAnyProcess']) === true);
  if (!anyProcess) {
    return undefined;
  }
  if (asString(rule['remote']) === 'any') {
    return '';
  }
  const entries = addressEntries(rule['remote-addresses']);
  if (entries.some((entry) => parseAddressSpan(entry) === undefined)) {
    return 'This rule is for any process, and this server cannot read all of its addresses, so it cannot tell whether the rule covers every address.';
  }
  return wholeFamilySentence(entries);
}

function assertPorts(ports: string): void {
  if (ports === 'any') {
    return;
  }
  const parts = ports.split('-');
  const numbers = parts.map((part) => (/^\d{1,5}$/.test(part) ? Number(part) : Number.NaN));
  const inRange = numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= 65_535);
  if (parts.length > 2 || !inRange || (numbers.length === 2 && (numbers[0] ?? 0) > (numbers[1] ?? 0))) {
    throw invalid('Ports must be "any", one port such as "443", or a range such as "8000-8100".');
  }
}

/** Checks a rule request before anything is read or changed. Throws with a message for the person. */
export function validateNewRule(spec: NewRuleSpec): void {
  if (spec.process !== 'any') {
    assertExecutablePath('process', spec.process);
  }
  if (spec.via !== undefined) {
    assertExecutablePath('"via" process', spec.via);
  }
  const given = [spec.remoteDomains, spec.remoteHosts, spec.remoteAddresses, spec.remote].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw invalid('Give exactly one of remote_domains, remote_hosts, remote_addresses or remote.');
  }
  for (const [label, list] of [['remote_domains', spec.remoteDomains], ['remote_hosts', spec.remoteHosts]] as const) {
    if (list === undefined) {
      continue;
    }
    if (list.length === 0 || list.length > 200) {
      throw invalid(`${label} must list between 1 and 200 names.`);
    }
    const bad = list.find((name) => !HOSTNAME.test(name.toLowerCase()) || !name.includes('.'));
    if (bad !== undefined) {
      throw invalid(`"${bad}" in ${label} is not a host or domain name. Give the bare name, such as example.com, with no scheme, path, port or wildcard.`);
    }
  }
  if (spec.remoteAddresses !== undefined) {
    if (spec.remoteAddresses.length === 0 || spec.remoteAddresses.length > 200) {
      throw invalid('remote_addresses must list between 1 and 200 addresses.');
    }
    const bad = spec.remoteAddresses.find((address) => parseAddressSpan(address) === undefined);
    if (bad !== undefined) {
      throw invalid(`"${bad}" in remote_addresses is not an IP address, a range (a-b) or a network (a/prefix).`);
    }
  }
  if (spec.process === 'any') {
    const wholeFamily = spec.remoteAddresses === undefined ? undefined : wholeFamilySentence(spec.remoteAddresses);
    if (spec.remote === 'any' || wholeFamily !== undefined) {
      throw invalid(`${wholeFamily === undefined ? '' : `${wholeFamily} `}${CATCH_ALL} This server does not create it; make such a rule in Little Snitch itself.`);
    }
  }
  if (spec.ports !== undefined) {
    assertPorts(spec.ports);
  }
  if (spec.notes !== undefined) {
    assertPlainNotes(spec.notes);
  }
}

/** The date form the configuration's own rules use, read from the first rule that has a date. */
export function dateEncodingOf(model: JsonObject): DateEncoding | undefined {
  for (const rule of rulesOf(model)) {
    const encoding = detectEncoding(rule['creationDate']) ?? detectEncoding(rule['modificationDate']);
    if (encoding !== undefined) {
      return encoding;
    }
  }
  return undefined;
}

const oneOrMany = (values: readonly string[]): JsonValue => (values.length === 1 && values[0] !== undefined ? values[0] : [...values]);

/**
 * Builds a rule in the shape Little Snitch gives the rules a person makes in
 * the app: only the fields that differ from the defaults, single remote values
 * as plain text, and dates in the form the other rules use.
 */
export function buildRule(spec: NewRuleSpec, context: { readonly uid: number; readonly now: Date; readonly model: JsonObject }): JsonObject {
  validateNewRule(spec);
  const encoding = dateEncodingOf(context.model);
  const date = encoding === undefined ? undefined : encodeDate(context.now, encoding);
  const lower = (values: readonly string[]): readonly string[] => values.map((value) => value.toLowerCase());
  const remote: JsonObject =
    spec.remoteDomains !== undefined
      ? { 'remote-domains': oneOrMany(lower(spec.remoteDomains)) }
      : spec.remoteHosts !== undefined
        ? { 'remote-hosts': oneOrMany(lower(spec.remoteHosts)) }
        : spec.remoteAddresses !== undefined
          ? { 'remote-addresses': oneOrMany(spec.remoteAddresses) }
          : { remote: spec.remote ?? 'any' };
  return {
    action: spec.action,
    ...(date === undefined ? {} : { creationDate: date, modificationDate: date }),
    origin: 'frontend',
    uid: numberValue(context.uid),
    process: spec.process,
    ...(spec.via === undefined ? {} : { via: spec.via }),
    ...remote,
    ...(spec.direction === 'incoming' ? { direction: 'incoming' } : {}),
    ...(spec.ports === undefined || spec.ports === 'any' ? {} : { ports: spec.ports }),
    ...(spec.protocol === undefined ? {} : { protocol: spec.protocol }),
    ...(spec.priority === 'high' ? { priority: 'high' } : {}),
    ...(spec.notes === undefined || spec.notes === '' ? {} : { notes: spec.notes }),
  };
}

export function addRule(model: JsonObject, rule: JsonObject): JsonObject {
  return { ...model, rules: [...rawRules(model), rule] };
}

/** Finds the one rule with this reference. A reference that fits no rule, or more than one, is an error. */
export function findRule(model: JsonObject, ref: string): { readonly index: number; readonly rule: JsonObject } {
  const hits = rawRules(model).flatMap((rule, index) => (isObject(rule) && ruleRef(rule) === ref ? [{ index, rule }] : []));
  if (hits.length === 1 && hits[0] !== undefined) {
    return hits[0];
  }
  if (hits.length > 1) {
    throw new LittleSnitchError('ambiguous', `${hits.length} identical rules share the reference ${ref}. Remove the duplicates in Little Snitch first.`);
  }
  throw new LittleSnitchError('not-found', `No rule has the reference ${ref}. Rules may have changed; list them again.`);
}

/** True for a rule that covers every process and every remote, all or nearly all addresses of a family, or addresses the server cannot read. */
export function isCatchAll(rule: JsonObject): boolean {
  return catchAllReason(rule) !== undefined;
}

function assertEditable(rule: JsonObject, ref: string): void {
  if (asBoolean(rule['protected']) === true || (rule['factoryID'] !== undefined && rule['factoryID'] !== null)) {
    throw new LittleSnitchError('protected', `Rule ${ref} is a protected or factory rule. This server does not change those; use Little Snitch itself.`);
  }
}

export function removeRule(model: JsonObject, ref: string): { readonly model: JsonObject; readonly removed: JsonObject } {
  const { index, rule } = findRule(model, ref);
  assertEditable(rule, ref);
  return { model: { ...model, rules: rawRules(model).filter((_, position) => position !== index) }, removed: rule };
}

export function updateRule(
  model: JsonObject,
  ref: string,
  patch: RulePatch,
  now: Date,
): { readonly model: JsonObject; readonly before: JsonObject; readonly after: JsonObject } {
  const { index, rule } = findRule(model, ref);
  assertEditable(rule, ref);
  if (patch.notes !== undefined) {
    assertPlainNotes(patch.notes);
  }
  const changes: JsonObject = {
    ...(patch.action === undefined || patch.action === asString(rule['action']) ? {} : { action: patch.action }),
    ...(patch.notes === undefined || patch.notes === (asString(rule['notes']) ?? '') ? {} : { notes: patch.notes }),
    ...(patch.priority === undefined || patch.priority === (asString(rule['priority']) ?? 'regular') ? {} : { priority: patch.priority }),
  };
  if (Object.keys(changes).length === 0) {
    throw invalid('Nothing to change: the rule already has these values.');
  }
  const catchAll = catchAllReason(rule);
  if (catchAll !== undefined && (changes['action'] !== undefined || changes['priority'] !== undefined)) {
    throw invalid(`${CATCH_ALL} ${catchAll === '' ? '' : `${catchAll} `}This server does not change the action or the priority of such a rule; do it in Little Snitch itself.`);
  }
  const encoding = detectEncoding(rule['modificationDate']);
  const merged: JsonObject = {
    ...rule,
    ...changes,
    ...(encoding === undefined ? {} : { modificationDate: encodeDate(now, encoding) }),
  };
  // Little Snitch leaves defaults out, so an emptied note or a regular priority is removed, not written.
  const after = Object.fromEntries(
    Object.entries(merged).filter(([key, value]) => !((key === 'notes' && value === '') || (key === 'priority' && value === 'regular'))),
  );
  return { model: { ...model, rules: rawRules(model).map((entry, position) => (position === index ? after : entry)) }, before: rule, after };
}
