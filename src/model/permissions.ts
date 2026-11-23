import { LittleSnitchError } from '../errors.js';
import { asNumber, isObject, type JsonObject } from './json.js';

/**
 * Little Snitch has its own switches for what a user may change, under
 * Settings > Security: "Allow Rule Editing" (rules, blocklists, profiles and
 * rule groups) and "Allow Profile Switching". The command-line tool runs as
 * root and is not bound by them. This server is: what the owner switched off
 * in Little Snitch, it does not do through the back door.
 *
 * The preference keys are matched to the switches by their names, as seen in
 * a real 6.5 configuration. Only a value of exactly `false` refuses a change;
 * a missing key or any other value does not.
 */
export type Permission = 'edit-rules' | 'switch-profile';

const KEYS: Readonly<Record<Permission, { readonly key: string; readonly label: string; readonly what: string }>> = {
  'edit-rules': { key: 'allowRuleAndProfileEditing', label: 'Allow Rule Editing', what: 'change rules, rule groups or blocklists' },
  'switch-profile': { key: 'allowProfileSwitching', label: 'Allow Profile Switching', what: 'switch profiles' },
};

export function assertAllowedByLittleSnitch(model: JsonObject, uid: number, permission: Permission): void {
  const users = model['users'];
  const user = (Array.isArray(users) ? users : []).filter(isObject).find((entry) => asNumber(entry['uid']) === uid);
  const defaults = user === undefined ? undefined : user['defaults'];
  const { key, label, what } = KEYS[permission];
  if (isObject(defaults) && defaults[key] === false) {
    throw new LittleSnitchError('capability-disabled', `In Little Snitch, "${label}" is switched off for this user, so this server does not ${what} either.`, {
      remedy: `Switch on "${label}" in Little Snitch > Settings > Security if you want this change made through the server.`,
    });
  }
}
