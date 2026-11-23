import { LittleSnitchError } from '../errors.js';
import { asString, isObject, toPlain, type JsonObject, type JsonValue } from './json.js';

export interface ProfileSummary {
  readonly id: string;
  readonly name: string | null;
  readonly other?: Readonly<Record<string, unknown>>;
}

export interface ActiveProfile {
  /** False when the configuration does not say which profile is active in a form this server recognises. */
  readonly known: boolean;
  /** The active profile's name, or null when no profile is active. Only meaningful when `known` is true. */
  readonly name?: string | null;
  /** Where in the configuration the answer was found. */
  readonly source?: string;
}

function entries(model: JsonObject): ReadonlyArray<readonly [string, JsonValue]> {
  const profiles = model['profiles'];
  if (isObject(profiles)) {
    return Object.entries(profiles);
  }
  if (Array.isArray(profiles)) {
    return profiles.map((profile, index) => [isObject(profile) ? asString(profile['id']) ?? String(index) : String(index), profile] as const);
  }
  return [];
}

export function summarizeProfiles(model: JsonObject): readonly ProfileSummary[] {
  return entries(model).map(([id, value]) => {
    if (!isObject(value)) {
      return { id, name: asString(value) ?? null };
    }
    const otherEntries = Object.entries(value).filter(([key]) => key !== 'name' && key !== 'id');
    return {
      id,
      name: asString(value['name']) ?? null,
      ...(otherEntries.length === 0 ? {} : { other: Object.fromEntries(otherEntries.map(([key, entry]) => [key, toPlain(entry)])) }),
    };
  });
}

const ACTIVE_KEY = /^(active|current)profile(id|name|identifier)?$/i;

/**
 * Looks for the active profile in the preference sections of the configuration.
 * The key is not documented by Objective Development, so this reports "not known"
 * when nothing matches instead of guessing.
 */
export function activeProfile(model: JsonObject, uid: number | undefined): ActiveProfile {
  const profiles = summarizeProfiles(model);
  const sections: Array<readonly [string, JsonValue | undefined]> = [];
  const users = model['users'];
  if (Array.isArray(users)) {
    for (const user of users) {
      if (isObject(user) && (uid === undefined || toPlain(user['uid']) === uid)) {
        sections.push([`users[uid ${String(toPlain(user['uid']))}].defaults`, user['defaults']]);
      }
    }
  }
  sections.push(['globalDefaults', model['globalDefaults']]);

  for (const [source, section] of sections) {
    if (!isObject(section)) {
      continue;
    }
    for (const [key, value] of Object.entries(section)) {
      if (!ACTIVE_KEY.test(key)) {
        continue;
      }
      if (value === null || value === '') {
        return { known: true, name: null, source: `${source}.${key}` };
      }
      const text = asString(value);
      if (text === undefined) {
        continue;
      }
      const match = profiles.find((profile) => profile.id === text || profile.name === text);
      return { known: true, name: match?.name ?? text, source: `${source}.${key}` };
    }
  }
  return { known: false };
}

/**
 * The configuration without the keys that say which profile is active, in the
 * global preferences and in every user's. Two configurations that are equal
 * after this differ in the active profile at most.
 */
export function withoutActiveProfile(model: JsonObject): JsonObject {
  const strip = (section: JsonValue | undefined): JsonValue | undefined =>
    isObject(section) ? Object.fromEntries(Object.entries(section).filter(([key]) => !ACTIVE_KEY.test(key))) : section;
  const users = model['users'];
  return {
    ...model,
    ...(model['globalDefaults'] === undefined ? {} : { globalDefaults: strip(model['globalDefaults']) ?? null }),
    ...(Array.isArray(users) ? { users: users.map((user) => (isObject(user) ? { ...user, defaults: strip(user['defaults']) ?? null } : user)) } : {}),
  };
}

/** Finds a profile by its exact name, so that a typo never activates a different profile. */
export function resolveProfile(model: JsonObject, name: string): ProfileSummary {
  const profiles = summarizeProfiles(model);
  const matches = profiles.filter((profile) => profile.name === name);
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new LittleSnitchError('ambiguous', `${matches.length} profiles are called "${name}". Rename one of them in Little Snitch first.`);
  }
  throw new LittleSnitchError('not-found', `No profile is called "${name}".`, {
    details: { available: profiles.map((profile) => profile.name) },
  });
}
