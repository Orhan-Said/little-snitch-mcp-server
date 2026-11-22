import { describe, expect, it } from 'vitest';
import { decodeDate, detectEncoding, encodeDate } from '../../src/model/dates.js';
import { canonical, numberValue, parseModelText, rawRules, rulesOf, serializeModel, toPlain, type JsonValue } from '../../src/model/json.js';
import { sampleModelText } from '../fixtures/model.js';

describe('parseModelText and serializeModel', () => {
  it('writes every number back exactly as it was read', () => {
    const text = serializeModel(parseModelText(sampleModelText()));
    expect(text).toContain('"futureFlag":18446744073709551615');
    expect(text).toContain('"lastUsed":816000000.5');
    expect(text).toContain('"silentMode":1.0');
  });

  it('keeps every rule and every top-level entry', () => {
    const model = parseModelText(sampleModelText());
    expect(rulesOf(model)).toHaveLength(4);
    expect(Object.keys(model).sort()).toEqual([
      'bundleVersion', 'disabledDomainsInLists', 'factoryRuleSetVersion', 'globalDefaults', 'groups', 'networkTriggers',
      'noProfilePseudoProfile', 'profiles', 'rules', 'users',
    ]);
  });

  it('refuses text that is not a configuration', () => {
    expect(() => parseModelText('not json')).toThrow(/not valid JSON/);
    expect(() => parseModelText('[1,2]')).toThrow(/not a JSON object/);
    expect(() => parseModelText('{"rules":{"a":1}}')).toThrow(/not a list/);
  });

  it('keeps list entries it cannot read when the list is written back', () => {
    const model = parseModelText('{"rules":[{"action":"allow"},"odd entry"]}');
    expect(rulesOf(model)).toHaveLength(1);
    expect(rawRules(model)).toHaveLength(2);
  });
});

describe('toPlain', () => {
  it('gives ordinary numbers as numbers and oversized ones as text', () => {
    const value = parseModelText('{"a":1.0,"b":18446744073709551615,"c":[2,"x",null,true]}');
    expect(toPlain(value)).toEqual({ a: 1, b: '18446744073709551615', c: [2, 'x', null, true] });
  });
});

describe('canonical', () => {
  it('ignores key order and how a number is spelled', () => {
    const a = parseModelText('{"x":1.0,"y":["a",{"k":2}]}');
    const b = parseModelText('{"y":["a",{"k":2.0}],"x":1}');
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).toBe('{"x":1,"y":["a",{"k":2}]}');
  });

  it('tells different values apart', () => {
    expect(canonical(parseModelText('{"x":1}'))).not.toBe(canonical(parseModelText('{"x":2}')));
    expect(canonical(parseModelText('{"x":18446744073709551615}'))).not.toBe(canonical(parseModelText('{"x":18446744073709551616}')));
  });
});

describe('dates', () => {
  it('reads text dates and seconds counted from 2001 or 1970', () => {
    expect(decodeDate('2026-01-10T09:00:00Z')).toBe('2026-01-10T09:00:00.000Z');
    expect(decodeDate(numberValue(816000000.5))).toBe('2026-11-10T10:40:00.500Z');
    expect(decodeDate(numberValue(1768035600))).toBe('2026-01-10T09:00:00.000Z');
  });

  it('does not treat other values as dates', () => {
    const notDates: JsonValue[] = ['soon', numberValue(0), true, null];
    expect(notDates.map((value) => decodeDate(value))).toEqual([undefined, undefined, undefined, undefined]);
    expect(detectEncoding(undefined)).toBeUndefined();
  });

  it('writes a date in the requested form', () => {
    const date = new Date('2026-11-22T16:00:00.789Z');
    expect(encodeDate(date, 'iso-string')).toBe('2026-11-22T16:00:00Z');
    expect(toPlain(encodeDate(date, 'cocoa-seconds'))).toBe(817056000);
    expect(toPlain(encodeDate(date, 'unix-seconds'))).toBe(1795363200);
  });
});
