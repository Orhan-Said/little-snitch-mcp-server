import { describe, expect, it } from 'vitest';
import { parseModelText, type JsonObject } from '../../src/model/json.js';
import { assertAllowedByLittleSnitch, littleSnitchSwitch } from '../../src/model/permissions.js';
import { activeProfile, withoutActiveProfile } from '../../src/model/profiles.js';
import { compareModels } from '../../src/model/verify.js';
import { sampleModel, sampleModelText } from '../fixtures/model.js';

/** A configuration with one user record, given as JSON text. */
const withUser = (user: string): JsonObject => parseModelText(`{"rules":[],"users":[${user}]}`);
const withSwitch = (value: string): JsonObject => withUser(`{"uid":501,"defaults":{"allowRuleAndProfileEditing":${value}}}`);

describe('littleSnitchSwitch', () => {
  it('reads the two switches of the sample configuration as on', () => {
    expect(littleSnitchSwitch(sampleModel(), 501, 'edit-rules')).toBe('on');
    expect(littleSnitchSwitch(sampleModel(), 501, 'switch-profile')).toBe('on');
  });

  it('reads yes and no in every form a preference may be written in', () => {
    for (const value of ['true', '1', '1.0', '"1"', '"true"', '"YES"', '" yes "']) {
      expect(littleSnitchSwitch(withSwitch(value), 501, 'edit-rules'), value).toBe('on');
    }
    for (const value of ['false', '0', '0.0', '"0"', '"false"', '"No"']) {
      expect(littleSnitchSwitch(withSwitch(value), 501, 'edit-rules'), value).toBe('off');
    }
  });

  it('does not take a value it does not understand for "on"', () => {
    for (const value of ['null', '2', '-1', '"maybe"', '""', '[]', '{}', '{"enabled":true}', '18446744073709551615']) {
      expect(littleSnitchSwitch(withSwitch(value), 501, 'edit-rules'), value).toBe('unreadable');
    }
  });

  it('says "not-found" when the user or the key is missing, and does not take that for "on" either', () => {
    expect(littleSnitchSwitch(withUser('{"uid":502,"defaults":{"allowRuleAndProfileEditing":false}}'), 501, 'edit-rules')).toBe('not-found');
    expect(littleSnitchSwitch(withUser('{"uid":501,"defaults":{}}'), 501, 'edit-rules')).toBe('not-found');
    expect(littleSnitchSwitch(withUser('{"uid":501}'), 501, 'edit-rules')).toBe('not-found');
    expect(littleSnitchSwitch(withUser('{"uid":501,"defaults":"none"}'), 501, 'edit-rules')).toBe('not-found');
    expect(littleSnitchSwitch(parseModelText('{"rules":[]}'), 501, 'edit-rules')).toBe('not-found');
    expect(littleSnitchSwitch(withSwitch('true'), 501, 'switch-profile')).toBe('not-found');
  });

  it('finds the user by an id written as a number or as text', () => {
    expect(littleSnitchSwitch(withUser('{"uid":"501","defaults":{"allowRuleAndProfileEditing":false}}'), 501, 'edit-rules')).toBe('off');
    expect(littleSnitchSwitch(withUser('{"uid":501.0,"defaults":{"allowRuleAndProfileEditing":0}}'), 501, 'edit-rules')).toBe('off');
    expect(littleSnitchSwitch(withUser('{"uid":5010,"defaults":{"allowRuleAndProfileEditing":false}}'), 501, 'edit-rules')).toBe('not-found');
  });
});

describe('assertAllowedByLittleSnitch', () => {
  it('lets a change through without a word when the switch is on', () => {
    expect(assertAllowedByLittleSnitch(withSwitch('true'), 501, 'edit-rules')).toBeUndefined();
  });

  it('refuses when the switch is off, however "off" is written', () => {
    for (const value of ['false', '0', '"no"']) {
      expect(() => assertAllowedByLittleSnitch(withSwitch(value), 501, 'edit-rules')).toThrow(
        expect.objectContaining({ kind: 'capability-disabled', message: 'In Little Snitch, "Allow Rule Editing" is switched off for this user, so this server does not change rules, rule groups or blocklists either.' }),
      );
    }
  });

  it('refuses when the switch has a value it does not understand', () => {
    expect(() => assertAllowedByLittleSnitch(withSwitch('"maybe"'), 501, 'edit-rules')).toThrow(
      expect.objectContaining({ kind: 'capability-disabled', message: expect.stringContaining('has a value in the configuration that this server does not understand') }),
    );
  });

  it('goes on when the switch is not in the configuration, and hands back a warning that says so', () => {
    const warning = assertAllowedByLittleSnitch(withUser('{"uid":501,"defaults":{}}'), 501, 'switch-profile');
    expect(warning).toBe(
      'Little Snitch\'s own switch "Allow Profile Switching" was not found in the configuration for this user, so this server could not respect it. If you switched it off in Little Snitch, undo this change there.',
    );
  });
});

describe('withoutActiveProfile', () => {
  it('takes out the key that names the active profile, for every user and globally, and nothing else', () => {
    const before = sampleModel();
    const switched = parseModelText(sampleModelText().replace('"activeProfile": "p2"', '"activeProfile": "p1"'));
    expect(activeProfile(switched, 501)).toMatchObject({ known: true, name: 'Home' });
    expect(compareModels(before, switched).ok).toBe(false);
    expect(compareModels(withoutActiveProfile(before), withoutActiveProfile(switched)).ok).toBe(true);

    const more = parseModelText(sampleModelText().replace('"activeProfile": "p2"', '"activeProfile": "p1"').replace('"networkFilterEnabled": true', '"networkFilterEnabled": false'));
    expect(compareModels(withoutActiveProfile(before), withoutActiveProfile(more))).toMatchObject({ ok: false, changedPreferenceKeys: ['globalDefaults.networkFilterEnabled'] });

    const global = parseModelText('{"rules":[],"globalDefaults":{"currentProfileID":"p1","activeSilentMode":0},"users":[{"uid":1,"defaults":{"ActiveProfileName":"Home","x":1}},"odd"]}');
    expect(withoutActiveProfile(global)).toEqual(parseModelText('{"rules":[],"globalDefaults":{"activeSilentMode":0},"users":[{"uid":1,"defaults":{"x":1}},"odd"]}'));
  });

  it('leaves a key alone that only has "profile" in its name', () => {
    const model = parseModelText('{"rules":[],"globalDefaults":{"allowProfileSwitching":true,"profileOrder":["p1"]}}');
    expect(withoutActiveProfile(model)).toEqual(model);
  });
});
