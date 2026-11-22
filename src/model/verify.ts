import { groupDisplayNames, summarizeGroups } from './groups.js';
import { rulesOf, type JsonObject } from './json.js';
import { summarizeProfiles } from './profiles.js';
import { ruleRef, semanticKey, summarizeRule, type RuleSummary } from './rules.js';

/** What a change was meant to do, stated against the configuration read just before it. */
export interface Expectation {
  /** References of rules that should be gone afterwards. */
  readonly removedRefs: readonly string[];
  /** Rules that should exist afterwards. They are matched by meaning, since Little Snitch may respell a rule it accepts. */
  readonly added: readonly JsonObject[];
}

export interface Verification {
  /** True when every rule that should survive is still there and every requested change took effect. */
  readonly ok: boolean;
  /** Rules that existed before, were not meant to change, and are gone. */
  readonly missing: readonly RuleSummary[];
  /** Requested rules that are not in the configuration afterwards. */
  readonly notApplied: readonly RuleSummary[];
  /** Rules that should have been removed and are still there. */
  readonly notRemoved: readonly RuleSummary[];
  /** Rules that appeared without being requested, for example one made in Little Snitch at the same moment. */
  readonly unexpected: readonly RuleSummary[];
  /** Differences outside the rule list: rule groups switched, profiles added or removed. */
  readonly otherChanges: readonly string[];
  /** True when the change failed and the rule list no longer matches what it was before. */
  readonly shouldRollBack: boolean;
}

function count(refs: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of refs) {
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

function otherChanges(before: JsonObject, after: JsonObject): readonly string[] {
  const changes: string[] = [];
  const afterGroups = new Map(summarizeGroups(after).map((group) => [group.id, group]));
  const beforeGroups = new Map(summarizeGroups(before).map((group) => [group.id, group]));
  for (const [id, group] of beforeGroups) {
    const now = afterGroups.get(id);
    const label = group.name ?? group.kind ?? id;
    if (now === undefined) {
      changes.push(`The rule group "${label}" is gone.`);
    } else if (now.active !== group.active) {
      changes.push(`The rule group "${label}" is now ${now.active === true ? 'on' : 'off'}.`);
    }
  }
  for (const [id, group] of afterGroups) {
    if (!beforeGroups.has(id)) {
      changes.push(`A rule group "${group.name ?? group.kind ?? id}" appeared.`);
    }
  }
  const beforeProfiles = new Set(summarizeProfiles(before).map((profile) => profile.id));
  const afterProfiles = new Set(summarizeProfiles(after).map((profile) => profile.id));
  for (const profile of summarizeProfiles(before)) {
    if (!afterProfiles.has(profile.id)) {
      changes.push(`The profile "${profile.name ?? profile.id}" is gone.`);
    }
  }
  for (const profile of summarizeProfiles(after)) {
    if (!beforeProfiles.has(profile.id)) {
      changes.push(`A profile "${profile.name ?? profile.id}" appeared.`);
    }
  }
  return changes;
}

/**
 * Compares the configuration read back after a change with what the change was
 * meant to produce. Fields Little Snitch updates on its own (last use, use
 * count) are ignored, so ordinary traffic during the change is not an error.
 */
export function verifyChange(before: JsonObject, after: JsonObject, expectation: Expectation): Verification {
  const beforeRules = rulesOf(before);
  const afterRules = rulesOf(after);
  const beforeNames = groupDisplayNames(before);
  const afterNames = groupDisplayNames(after);
  const removed = count(expectation.removedRefs);

  // Rules expected to survive untouched: everything from before, less the removals.
  const survivors = new Map<string, JsonObject[]>();
  const removalsLeft = new Map(removed);
  for (const rule of beforeRules) {
    const ref = ruleRef(rule);
    const left = removalsLeft.get(ref) ?? 0;
    if (left > 0) {
      removalsLeft.set(ref, left - 1);
      continue;
    }
    survivors.set(ref, [...(survivors.get(ref) ?? []), rule]);
  }

  const extras: JsonObject[] = [];
  for (const rule of afterRules) {
    const ref = ruleRef(rule);
    const waiting = survivors.get(ref);
    if (waiting !== undefined && waiting.length > 0) {
      survivors.set(ref, waiting.slice(1));
    } else {
      extras.push(rule);
    }
  }

  const missing = [...survivors.values()].flat().map((rule) => summarizeRule(rule, beforeNames));
  const notRemoved = extras.filter((rule) => removed.has(ruleRef(rule)));
  let unclaimed = extras.filter((rule) => !removed.has(ruleRef(rule)));
  const notApplied: JsonObject[] = [];
  for (const wanted of expectation.added) {
    const key = semanticKey(wanted);
    const index = unclaimed.findIndex((rule) => semanticKey(rule) === key);
    if (index === -1) {
      notApplied.push(wanted);
    } else {
      unclaimed = unclaimed.filter((_, position) => position !== index);
    }
  }

  const ok = missing.length === 0 && notApplied.length === 0 && notRemoved.length === 0;
  const afterCounts = count(afterRules.map(ruleRef));
  const sameRulesAsBefore =
    beforeRules.length === afterRules.length && [...count(beforeRules.map(ruleRef))].every(([ref, total]) => afterCounts.get(ref) === total);

  return {
    ok,
    missing,
    notApplied: notApplied.map((rule) => summarizeRule(rule, afterNames)),
    notRemoved: notRemoved.map((rule) => summarizeRule(rule, afterNames)),
    unexpected: unclaimed.map((rule) => summarizeRule(rule, afterNames)),
    otherChanges: otherChanges(before, after),
    shouldRollBack: !ok && !sameRulesAsBefore,
  };
}
