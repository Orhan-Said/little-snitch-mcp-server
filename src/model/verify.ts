import { groupDisplayNames, summarizeGroups } from './groups.js';
import { canonical, isObject, rawRules, rulesOf, type JsonObject } from './json.js';
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
 * groups or profiles all count as a difference. Only two things are ignored:
 * the fields Little Snitch updates as traffic flows (a rule's last use and use
 * count), and the sections listed in LITTLE_SNITCH_OWNED_SECTIONS.
 */
export function compareModels(expected: JsonObject, actual: JsonObject, options: CompareOptions = {}): Comparison {
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
  ];
  return parts.length === 0 ? 'no difference' : parts.join('; ');
}
