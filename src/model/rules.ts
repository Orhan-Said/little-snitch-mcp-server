import { decodeDate } from './dates.js';
import { asBoolean, asNumber, asString, canonical, sha256, toPlain, without, type JsonObject, type JsonValue } from './json.js';

/** Fields Little Snitch updates by itself as traffic flows. They are not part of a rule's identity. */
export const VOLATILE_RULE_KEYS = ['lastUsed', 'useCount'] as const;

export type Remote =
  | { readonly kind: 'any' }
  | { readonly kind: 'special'; readonly value: string }
  | { readonly kind: 'domains' | 'hosts' | 'addresses'; readonly values: readonly string[] }
  | { readonly kind: 'unspecified' };

export interface RuleSummary {
  /** Identifies the rule in later calls. It changes when the rule's content changes. */
  readonly ref: string;
  readonly action: string | null;
  readonly process: string | null;
  readonly via?: string;
  readonly remote: Remote;
  readonly direction: string;
  readonly ports?: string;
  readonly protocol?: string;
  readonly priority: string;
  readonly notes?: string;
  readonly group?: { readonly id: string; readonly name: string | null };
  readonly uid?: number;
  readonly origin?: string;
  readonly protected: boolean;
  readonly factory: boolean;
  readonly created?: string;
  readonly modified?: string;
  readonly lastUsed?: string;
  readonly useCount?: number;
  /** Fields this server does not interpret, shown as Little Snitch wrote them. */
  readonly other?: Readonly<Record<string, unknown>>;
}

const KNOWN_KEYS = [
  'action', 'process', 'via', 'remote', 'remote-domains', 'remote-hosts', 'remote-addresses', 'direction', 'ports',
  'protocol', 'priority', 'notes', 'group', 'uid', 'origin', 'protected', 'factoryID', 'creationDate',
  'modificationDate', 'lastUsed', 'useCount',
] as const;

const PROTOCOL_NUMBERS: Readonly<Record<string, string>> = { icmp: '1', tcp: '6', udp: '17', icmpv6: '58', 'ipv6-icmp': '58' };

/** A short, stable reference derived from the rule's content, without the fields Little Snitch updates on its own. */
export function ruleRef(rule: JsonObject): string {
  return `r${sha256(canonical(without(rule, VOLATILE_RULE_KEYS))).slice(0, 12)}`;
}

function stringList(value: JsonValue | undefined): readonly string[] | undefined {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return undefined;
}

export function remoteOf(rule: JsonObject): Remote {
  for (const [key, kind] of [['remote-domains', 'domains'], ['remote-hosts', 'hosts'], ['remote-addresses', 'addresses']] as const) {
    const values = stringList(rule[key]);
    if (values !== undefined) {
      return { kind, values };
    }
  }
  const special = asString(rule['remote']);
  if (special === undefined) {
    return { kind: 'unspecified' };
  }
  return special === 'any' ? { kind: 'any' } : { kind: 'special', value: special };
}

export function describeRemote(remote: Remote): string {
  switch (remote.kind) {
    case 'any':
      return 'any';
    case 'special':
      return remote.value;
    case 'unspecified':
      return 'unspecified';
    default:
      return `${remote.kind}: ${remote.values.join(', ')}`;
  }
}

function normalizeProtocol(value: string | undefined): string {
  if (value === undefined || value === '' || value === 'any') {
    return 'any';
  }
  const lower = value.toLowerCase();
  return PROTOCOL_NUMBERS[lower] ?? lower;
}

/**
 * What a rule means, in a form that stays the same when Little Snitch rewrites
 * how it is spelled (a default left out, a protocol name turned into a number).
 */
export function semanticKey(rule: JsonObject): string {
  const remote = remoteOf(rule);
  const remoteKey =
    remote.kind === 'domains' || remote.kind === 'hosts' || remote.kind === 'addresses'
      ? `${remote.kind}:${remote.values.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter((value) => value !== '').sort().join(',')}`
      : describeRemote(remote);
  return JSON.stringify([
    (asString(rule['action']) ?? '').toLowerCase(),
    asString(rule['process']) ?? '',
    asString(rule['via']) ?? '',
    remoteKey,
    asString(rule['direction']) ?? 'outgoing',
    asString(rule['ports']) ?? 'any',
    normalizeProtocol(asString(rule['protocol'])),
    asString(rule['priority']) ?? 'regular',
  ]);
}

const DATE_KEYS = ['creationDate', 'modificationDate'] as const;
const REMOTE_LIST_KEYS: readonly string[] = ['remote-domains', 'remote-hosts', 'remote-addresses'];

/**
 * The whole rule, every field included, in a form that stays the same under the
 * few respellings Little Snitch is known or expected to make to a rule it
 * accepts: its own dates, a default it leaves out, a protocol name turned into
 * a number, one remote written as text or as a list. A written rule must come
 * back with this key unchanged. Anything else that differs, such as the user,
 * the group, the notes or a field this server does not know, is a real difference.
 */
export function tolerantKey(rule: JsonObject): string {
  const entries = Object.entries(without(rule, [...VOLATILE_RULE_KEYS, ...DATE_KEYS])).flatMap(([key, value]): Array<[string, JsonValue]> => {
    if (key === 'protocol') {
      const protocol = normalizeProtocol(asString(value));
      return protocol === 'any' ? [] : [[key, protocol]];
    }
    if ((key === 'direction' && value === 'outgoing') || (key === 'priority' && value === 'regular') || (key === 'ports' && value === 'any')) {
      return [];
    }
    // Only a list made of text alone is respelled. One with anything else in it must match exactly.
    const textOnly = typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
    const list = REMOTE_LIST_KEYS.includes(key) && textOnly ? stringList(value) : undefined;
    if (list !== undefined) {
      const values = list.flatMap((entry) => entry.split(',')).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
      return [[key, [...values].sort()]];
    }
    return [[key, value]];
  });
  return canonical(Object.fromEntries(entries));
}

export function summarizeRule(rule: JsonObject, groupNames: ReadonlyMap<string, string | null>): RuleSummary {
  const optional = <T>(key: string, value: T | undefined): Record<string, T> => (value === undefined ? {} : { [key]: value });
  const groupId = asString(rule['group']);
  const otherEntries = Object.entries(rule).filter(([key]) => !(KNOWN_KEYS as readonly string[]).includes(key));
  return {
    ref: ruleRef(rule),
    action: asString(rule['action']) ?? null,
    process: asString(rule['process']) ?? null,
    ...optional('via', asString(rule['via'])),
    remote: remoteOf(rule),
    direction: asString(rule['direction']) ?? 'outgoing',
    ...optional('ports', asString(rule['ports'])),
    ...optional('protocol', asString(rule['protocol'])),
    priority: asString(rule['priority']) ?? 'regular',
    ...optional('notes', asString(rule['notes'])),
    ...(groupId === undefined ? {} : { group: { id: groupId, name: groupNames.get(groupId) ?? null } }),
    ...optional('uid', asNumber(rule['uid'])),
    ...optional('origin', asString(rule['origin'])),
    protected: asBoolean(rule['protected']) === true,
    factory: rule['factoryID'] !== undefined && rule['factoryID'] !== null,
    ...optional('created', decodeDate(rule['creationDate'])),
    ...optional('modified', decodeDate(rule['modificationDate'])),
    ...optional('lastUsed', decodeDate(rule['lastUsed'])),
    ...optional('useCount', asNumber(rule['useCount'])),
    ...(otherEntries.length === 0 ? {} : { other: Object.fromEntries(otherEntries.map(([key, value]) => [key, toPlain(value)])) }),
  };
}

export type RuleSort = 'none' | 'last_used' | 'use_count' | 'created' | 'process';

export interface RuleFilter {
  readonly process?: string;
  readonly remote?: string;
  readonly action?: string;
  readonly direction?: string;
  readonly group?: string;
  readonly text?: string;
  /** Keep rules not used for at least this many days, and rules never used. */
  readonly unusedForDays?: number;
  readonly sort?: RuleSort;
}

const contains = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle.toLowerCase());

/** The process as a filter reads it. A rule for any process with a trusted signature names no process of its own. */
function processText(rule: RuleSummary): string | null {
  if (rule.process === null && rule.other?.['requiresTrustedSignatureForAnyProcess'] === true) {
    return 'any process with a trusted signature';
  }
  return rule.process;
}

function matches(rule: RuleSummary, filter: RuleFilter, now: Date): boolean {
  if (filter.process !== undefined && !contains(processText(rule), filter.process) && !contains(rule.via, filter.process)) {
    return false;
  }
  if (filter.remote !== undefined && !contains(describeRemote(rule.remote), filter.remote)) {
    return false;
  }
  if (filter.action !== undefined && rule.action !== filter.action) {
    return false;
  }
  if (filter.direction !== undefined && rule.direction !== filter.direction) {
    return false;
  }
  if (filter.group !== undefined) {
    const wanted = filter.group.toLowerCase();
    if (rule.group === undefined || (rule.group.id.toLowerCase() !== wanted && (rule.group.name ?? '').toLowerCase() !== wanted)) {
      return false;
    }
  }
  if (filter.text !== undefined) {
    const blob = [rule.process, rule.via, describeRemote(rule.remote), rule.notes, rule.group?.name].join('\n');
    if (!contains(blob, filter.text)) {
      return false;
    }
  }
  if (filter.unusedForDays !== undefined) {
    const cutoff = now.getTime() - filter.unusedForDays * 86_400_000;
    if (rule.lastUsed !== undefined && Date.parse(rule.lastUsed) > cutoff) {
      return false;
    }
  }
  return true;
}

function compare(sort: RuleSort): ((a: RuleSummary, b: RuleSummary) => number) | undefined {
  switch (sort) {
    case 'last_used':
      return (a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '');
    case 'use_count':
      return (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0);
    case 'created':
      return (a, b) => (b.created ?? '').localeCompare(a.created ?? '');
    case 'process':
      return (a, b) => (a.process ?? '').localeCompare(b.process ?? '');
    default:
      return undefined;
  }
}

export function filterRules(rules: readonly RuleSummary[], filter: RuleFilter, now: Date): readonly RuleSummary[] {
  const kept = rules.filter((rule) => matches(rule, filter, now));
  const order = compare(filter.sort ?? 'none');
  return order === undefined ? kept : [...kept].sort(order);
}
