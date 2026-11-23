import { LittleSnitchError } from '../errors.js';
import { isObject, toPlain, type JsonObject, type JsonValue } from './json.js';

/**
 * Little Snitch has its own switches for what a user may change, under
 * Settings > Security: "Allow Rule Editing" (rules, blocklists, profiles and
 * rule groups) and "Allow Profile Switching". The command-line tool runs as
 * root and is not bound by them. This server looks at them first: what the
 * owner switched off in Little Snitch, it does not do through the back door.
 *
 * This is a courtesy, not a security boundary. The preference keys are matched
 * to the switches by their names, as seen in one real 6.5 configuration; how
 * other versions store them is not known. So the answer has four values, and
 * only a switch that was found and reads as "on" counts as on:
 *
 * - "on": the key is there with a value that means yes.
 * - "off": the key is there with a value that means no. The change is refused.
 * - "unreadable": the key is there with a value this server does not
 *   understand. The change is refused.
 * - "not-found": no record for this user, or no such key. The change is made,
 *   and its result says that the switch could not be respected.
 */
export type Permission = 'edit-rules' | 'switch-profile';
export type SwitchState = 'on' | 'off' | 'unreadable' | 'not-found';

const KEYS: Readonly<Record<Permission, { readonly key: string; readonly label: string; readonly what: string }>> = {
  'edit-rules': { key: 'allowRuleAndProfileEditing', label: 'Allow Rule Editing', what: 'change rules, rule groups or blocklists' },
  'switch-profile': { key: 'allowProfileSwitching', label: 'Allow Profile Switching', what: 'switch profiles' },
};

const YES: readonly unknown[] = [true, 1, '1', 'true', 'yes'];
const NO: readonly unknown[] = [false, 0, '0', 'false', 'no'];

function readSwitch(value: JsonValue): SwitchState {
  const plain = toPlain(value);
  const normal = typeof plain === 'string' ? plain.trim().toLowerCase() : plain;
  return YES.includes(normal) ? 'on' : NO.includes(normal) ? 'off' : 'unreadable';
}

/** The user's record, found by a user id written as a number or as text. */
function userDefaults(model: JsonObject, uid: number): JsonValue | undefined {
  const users = model['users'];
  const user = (Array.isArray(users) ? users : []).filter(isObject).find((entry) => {
    const id = entry['uid'];
    return id !== undefined && String(toPlain(id)).trim() === String(uid);
  });
  return user === undefined ? undefined : user['defaults'];
}

export function littleSnitchSwitch(model: JsonObject, uid: number, permission: Permission): SwitchState {
  const defaults = userDefaults(model, uid);
  if (!isObject(defaults)) {
    return 'not-found';
  }
  const value = defaults[KEYS[permission].key];
  return value === undefined ? 'not-found' : readSwitch(value);
}

/**
 * Refuses a change that Little Snitch's own switch forbids. Returns a warning
 * for the result when the switch could not be found, and nothing otherwise.
 */
export function assertAllowedByLittleSnitch(model: JsonObject, uid: number, permission: Permission): string | undefined {
  const { label, what } = KEYS[permission];
  const state = littleSnitchSwitch(model, uid, permission);
  if (state === 'off') {
    throw new LittleSnitchError('capability-disabled', `In Little Snitch, "${label}" is switched off for this user, so this server does not ${what} either.`, {
      remedy: `Switch on "${label}" in Little Snitch > Settings > Security if you want this change made through the server.`,
    });
  }
  if (state === 'unreadable') {
    throw new LittleSnitchError(
      'capability-disabled',
      `Little Snitch's switch "${label}" has a value in the configuration that this server does not understand, so it cannot tell whether you allow it to ${what}. Nothing was changed.`,
      { remedy: 'Make the change in Little Snitch itself, and please report this, so the value can be supported.' },
    );
  }
  return state === 'not-found'
    ? `Little Snitch's own switch "${label}" was not found in the configuration for this user, so this server could not respect it. If you switched it off in Little Snitch, undo this change there.`
    : undefined;
}
