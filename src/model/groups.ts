import { LittleSnitchError } from '../errors.js';
import { asBoolean, asString, isObject, rulesOf, toPlain, type JsonObject } from './json.js';

/**
 * Built-in rule groups carry no name in the configuration, only a kind, while
 * `littlesnitch rulegroup` accepts only the name shown in the app. This table
 * holds the English names seen so far; a kind missing from it is reported, not guessed.
 */
export const BUILTIN_GROUP_NAMES: Readonly<Record<string, string>> = {
  builtinMacOSServices: 'macOS Services',
  builtinICloudServices: 'iCloud Services',
};

export interface GroupSummary {
  readonly id: string;
  /** The name to show, and to pass to Little Snitch. Null when it is not known. */
  readonly name: string | null;
  readonly nameSource: 'configuration' | 'built-in table' | 'unknown';
  readonly kind: string | null;
  readonly active: boolean | null;
  readonly ruleCount: number;
  readonly other?: Readonly<Record<string, unknown>>;
}

const KNOWN_KEYS = ['name', 'kind', 'isActive'];

export function summarizeGroups(model: JsonObject): readonly GroupSummary[] {
  const groups = model['groups'];
  if (!isObject(groups)) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const rule of rulesOf(model)) {
    const id = asString(rule['group']);
    if (id !== undefined) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return Object.entries(groups).flatMap(([id, value]) => {
    if (!isObject(value)) {
      return [];
    }
    const kind = asString(value['kind']) ?? null;
    const ownName = asString(value['name']);
    const builtin = kind === null ? undefined : BUILTIN_GROUP_NAMES[kind];
    const otherEntries = Object.entries(value).filter(([key]) => !KNOWN_KEYS.includes(key));
    const summary: GroupSummary = {
      id,
      name: ownName ?? builtin ?? null,
      nameSource: ownName !== undefined ? 'configuration' : builtin !== undefined ? 'built-in table' : 'unknown',
      kind,
      active: asBoolean(value['isActive']) ?? null,
      ruleCount: counts.get(id) ?? 0,
      ...(otherEntries.length === 0 ? {} : { other: Object.fromEntries(otherEntries.map(([key, entry]) => [key, toPlain(entry)])) }),
    };
    return [summary];
  });
}

export function groupDisplayNames(model: JsonObject): ReadonlyMap<string, string | null> {
  return new Map(summarizeGroups(model).map((group) => [group.id, group.name]));
}

/**
 * Finds the one group a caller means by id, name or kind. An exact match wins;
 * otherwise a name that differs only in letter case is accepted when it is unique.
 * There is no fuzzy matching: a typo must not switch a different group.
 */
export function resolveGroup(model: JsonObject, query: string): GroupSummary {
  const groups = summarizeGroups(model);
  const exact = groups.filter((group) => group.id === query || group.name === query || group.kind === query);
  const lower = query.toLowerCase();
  const candidates = exact.length > 0 ? exact : groups.filter((group) => (group.name ?? '').toLowerCase() === lower);
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new LittleSnitchError('ambiguous', `"${query}" matches ${candidates.length} rule groups. Use the group's id.`, {
      details: { matches: candidates.map((group) => ({ id: group.id, name: group.name, kind: group.kind })) },
    });
  }
  throw new LittleSnitchError('not-found', `No rule group or blocklist is called "${query}".`, {
    details: { available: groups.map((group) => ({ id: group.id, name: group.name, kind: group.kind })) },
  });
}
