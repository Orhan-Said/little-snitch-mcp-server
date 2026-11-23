import { groupDisplayNames, summarizeGroups } from './groups.js';
import { canonical, isObject, rawRules, rulesOf, without, type JsonObject, type JsonValue } from './json.js';
import { summarizeProfiles } from './profiles.js';
import { ruleRef, summarizeRule, tolerantKey, type RuleSummary } from './rules.js';

/**
 * Parts of the configuration that Little Snitch writes on its own account:
 * counters, caches of programs it has seen, and its own version markers. They
 * hold no rule, switch or preference, so a difference in them is not a
 * difference in the firewall. Everything else must match exactly.
 */
export const LITTLE_SNITCH_OWNED_SECTIONS = [
  'blocklistStatistics',
  'statisticsModelCreationDate',
  'lastSeenExecutableByCodeIdentifier',
  'bundleVersion',
  'factoryRuleSetVersion',
] as const;

/**
 * Preference keys that hold no policy and that Little Snitch rewrites while it
 * runs: the process id of an open window, the time of its last address
 * database check, the map position of the Network Monitor. They were chosen
 * from their names in a real 6.5 configuration, not from watching them change.
 * A difference in them alone is not a difference in the firewall.
 */
export const VOLATILE_PREFERENCE_KEYS = [
  'pidOfLSCShowingWelcomeWindow',
  'ipAddressDatabaseLastUpdateCheck',
  'ipAddressDatabaseLastUpdateCheckFailed',
  'GeoViewMyLocationLatitude',
  'GeoViewMyLocationLongitude',
] as const;

export interface CompareOptions {
  /**
   * Rules of the expected configuration that were just written. For these, the
   * dates and a few known respellings may differ (see `tolerantKey`); every
   * other field, known or not, must come back as sent.
   */
  readonly written?: readonly JsonObject[];
  /** References of rules that were meant to disappear. Used to say "not removed" instead of "unexpected". */
  readonly removedRefs?: readonly string[];
}

export interface Comparison {
  /** True only when the two configurations hold the same firewall: the same rules and the same everything else. */
  readonly ok: boolean;
  /** Rules that should be there and are not. */
  readonly missing: readonly RuleSummary[];
  /** Rules that are there and should not be: nobody asked for them. */
  readonly unexpected: readonly RuleSummary[];
  /** Rules that were written and did not come back as sent. */
  readonly notApplied: readonly RuleSummary[];
  /** Rules that should have been removed and are still there. */
  readonly notRemoved: readonly RuleSummary[];
  /** Top-level parts other than the rule list that differ, by name: preferences, groups, profiles and so on. */
  readonly changedSections: readonly string[];
  /** The preference keys that differ, by name and without their values, such as "globalDefaults.networkFilterEnabled". */
  readonly changedPreferenceKeys: readonly string[];
  /** The group and profile differences in words, where they can be described. */
  readonly otherChanges: readonly string[];
}

function describeGroupsAndProfiles(expected: JsonObject, actual: JsonObject): readonly string[] {
  const changes: string[] = [];
  const actualGroups = new Map(summarizeGroups(actual).map((group) => [group.id, group]));
  const expectedGroups = new Map(summarizeGroups(expected).map((group) => [group.id, group]));
  for (const [id, group] of expectedGroups) {
    const now = actualGroups.get(id);
    const label = group.name ?? group.kind ?? id;
    if (now === undefined) {
      changes.push(`The rule group "${label}" is gone.`);
    } else if (now.active !== group.active) {
      changes.push(`The rule group "${label}" is ${now.active === true ? 'on' : 'off'} and should be ${group.active === true ? 'on' : 'off'}.`);
    }
  }
  for (const [id, group] of actualGroups) {
    if (!expectedGroups.has(id)) {
      changes.push(`A rule group "${group.name ?? group.kind ?? id}" appeared.`);
    }
  }
  const expectedProfiles = new Set(summarizeProfiles(expected).map((profile) => profile.id));
  const actualProfiles = new Set(summarizeProfiles(actual).map((profile) => profile.id));
  for (const profile of summarizeProfiles(expected)) {
    if (!actualProfiles.has(profile.id)) {
      changes.push(`The profile "${profile.name ?? profile.id}" is gone.`);
    }
  }
  for (const profile of summarizeProfiles(actual)) {
    if (!expectedProfiles.has(profile.id)) {
      changes.push(`A profile "${profile.name ?? profile.id}" appeared.`);
    }
  }
  return changes;
}

const dropVolatile = (preferences: JsonValue | undefined): JsonValue | undefined =>
  isObject(preferences) ? without(preferences, VOLATILE_PREFERENCE_KEYS) : preferences;

/** The configuration with the volatile preference keys taken out of the global and the per-user preferences. */
function withoutVolatilePreferences(model: JsonObject): JsonObject {
  const users = model['users'];
  return {
    ...model,
    ...(model['globalDefaults'] === undefined ? {} : { globalDefaults: dropVolatile(model['globalDefaults']) ?? null }),
    ...(Array.isArray(users) ? { users: users.map((user) => (isObject(user) ? { ...user, defaults: dropVolatile(user['defaults']) ?? null } : user)) } : {}),
  };
}

function differingKeys(label: string, expected: JsonValue | undefined, actual: JsonValue | undefined): readonly string[] {
  if (!isObject(expected) || !isObject(actual)) {
    return canonical(expected) === canonical(actual) ? [] : [label];
  }
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .sort()
    .filter((key) => canonical(expected[key]) !== canonical(actual[key]))
    .map((key) => `${label}.${key}`);
}

/** Names the preference keys that differ. Values are left out: they are the person's settings. */
function changedPreferenceKeys(expected: JsonObject, actual: JsonObject): readonly string[] {
  const userDefaults = (model: JsonObject): Map<string, JsonValue | undefined> => {
    const users = model['users'];
    return new Map((Array.isArray(users) ? users : []).filter(isObject).map((user) => [canonical(user['uid']), user['defaults']]));
  };
  const expectedUsers = userDefaults(expected);
  const actualUsers = userDefaults(actual);
  return [
    ...differingKeys('globalDefaults', expected['globalDefaults'], actual['globalDefaults']),
    ...[...new Set([...expectedUsers.keys(), ...actualUsers.keys()])].sort().flatMap((uid) => differingKeys(`users[uid ${uid}].defaults`, expectedUsers.get(uid), actualUsers.get(uid))),
  ];
}

function changedSections(expected: JsonObject, actual: JsonObject): readonly string[] {
  const ignored: readonly string[] = ['rules', ...LITTLE_SNITCH_OWNED_SECTIONS];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((key) => !ignored.includes(key)).sort();
  return keys.filter((key) => canonical(expected[key]) !== canonical(actual[key]));
}

/** Entries of the rule list that are not rule objects. This server cannot read them, so they must simply be the same, one for one. */
function opaqueRuleEntries(model: JsonObject): string {
  return JSON.stringify(rawRules(model).filter((entry) => !isObject(entry)).map((entry) => canonical(entry)).sort());
}

export const OPAQUE_RULE_ENTRIES = 'rules (entries that are not rule objects)';

/**
 * Compares the configuration Little Snitch reports with the one that was
 * intended. The comparison is strict: a rule nobody asked for, a field of a
 * written rule that came back different, and any change to preferences, rule
 * groups or profiles all count as a difference. Only three things are ignored:
 * the fields Little Snitch updates as traffic flows (a rule's last use and use
 * count), the sections listed in LITTLE_SNITCH_OWNED_SECTIONS, and the
 * preference keys listed in VOLATILE_PREFERENCE_KEYS.
 */
export function compareModels(expectedModel: JsonObject, actualModel: JsonObject, options: CompareOptions = {}): Comparison {
  const expected = withoutVolatilePreferences(expectedModel);
  const actual = withoutVolatilePreferences(actualModel);
  const written = new Set(options.written ?? []);
  const removed = new Set(options.removedRefs ?? []);
  const expectedNames = groupDisplayNames(expected);
  const actualNames = groupDisplayNames(actual);

  // Rules that must be there exactly as they are, grouped by reference.
  const waiting = new Map<string, JsonObject[]>();
  for (const rule of rulesOf(expected)) {
    if (!written.has(rule)) {
      const ref = ruleRef(rule);
      waiting.set(ref, [...(waiting.get(ref) ?? []), rule]);
    }
  }
  let extras: JsonObject[] = [];
  for (const rule of rulesOf(actual)) {
    const ref = ruleRef(rule);
    const queue = waiting.get(ref);
    if (queue !== undefined && queue.length > 0) {
      waiting.set(ref, queue.slice(1));
    } else {
      extras.push(rule);
    }
  }
  const missing = [...waiting.values()].flat();

  const notApplied: JsonObject[] = [];
  for (const rule of written) {
    const key = tolerantKey(rule);
    const index = extras.findIndex((candidate) => tolerantKey(candidate) === key);
    if (index === -1) {
      notApplied.push(rule);
    } else {
      extras = extras.filter((_, position) => position !== index);
    }
  }
  const notRemoved = extras.filter((rule) => removed.has(ruleRef(rule)));
  const unexpected = extras.filter((rule) => !removed.has(ruleRef(rule)));
  const sections = [
    ...changedSections(expected, actual),
    ...(opaqueRuleEntries(expected) === opaqueRuleEntries(actual) ? [] : [OPAQUE_RULE_ENTRIES]),
  ];

  return {
    ok: missing.length === 0 && unexpected.length === 0 && notApplied.length === 0 && notRemoved.length === 0 && sections.length === 0,
    missing: missing.map((rule) => summarizeRule(rule, expectedNames)),
    unexpected: unexpected.map((rule) => summarizeRule(rule, actualNames)),
    notApplied: notApplied.map((rule) => summarizeRule(rule, expectedNames)),
    notRemoved: notRemoved.map((rule) => summarizeRule(rule, actualNames)),
    changedSections: sections,
    changedPreferenceKeys: changedPreferenceKeys(expected, actual),
    otherChanges: describeGroupsAndProfiles(expected, actual),
  };
}

/** A short account of a failed comparison, for error details. Lists are cut to 20 entries. */
export function comparisonDetails(comparison: Comparison): Record<string, unknown> {
  const cut = <T>(list: readonly T[]): readonly T[] => list.slice(0, 20);
  return {
    missing: cut(comparison.missing),
    unexpected: cut(comparison.unexpected),
    notApplied: cut(comparison.notApplied),
    notRemoved: cut(comparison.notRemoved),
    changedSections: comparison.changedSections,
    changedPreferenceKeys: comparison.changedPreferenceKeys,
    otherChanges: comparison.otherChanges,
  };
}

/** One sentence saying how two configurations differ. */
export function describeComparison(comparison: Comparison): string {
  const parts = [
    ...(comparison.missing.length > 0 ? [`${comparison.missing.length} rule(s) missing`] : []),
    ...(comparison.unexpected.length > 0 ? [`${comparison.unexpected.length} rule(s) nobody asked for`] : []),
    ...(comparison.notApplied.length > 0 ? [`${comparison.notApplied.length} written rule(s) not as sent`] : []),
    ...(comparison.notRemoved.length > 0 ? [`${comparison.notRemoved.length} rule(s) not removed`] : []),
    ...(comparison.changedSections.length > 0 ? [`these parts differ: ${comparison.changedSections.join(', ')}`] : []),
    ...(comparison.changedPreferenceKeys.length > 0 ? [`preference keys that differ: ${comparison.changedPreferenceKeys.slice(0, 12).join(', ')}`] : []),
  ];
  return parts.length === 0 ? 'no difference' : parts.join('; ');
}
