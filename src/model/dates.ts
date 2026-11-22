import { asNumber, asString, isNumber, numberValue, type JsonValue } from './json.js';

/**
 * Little Snitch has written dates in more than one form across versions:
 * ISO-8601 text, and plain seconds counted from 2001 (Apple's reference date).
 * This server reads all of them and, when it writes a date, copies the form
 * the configuration already uses.
 */
export type DateEncoding = 'iso-string' | 'cocoa-seconds' | 'unix-seconds';

/** Seconds between 1970-01-01 and 2001-01-01. */
const COCOA_EPOCH_OFFSET = 978_307_200;
/** Seconds values below this are counted from 2001; above, from 1970. The two ranges do not meet before 2042. */
const COCOA_LIMIT = 1_300_000_000;

export function detectEncoding(value: JsonValue | undefined): DateEncoding | undefined {
  if (typeof value === 'string') {
    return Number.isNaN(Date.parse(value)) ? undefined : 'iso-string';
  }
  const seconds = asNumber(value);
  if (!isNumber(value) || seconds === undefined || seconds <= 0) {
    return undefined;
  }
  return seconds < COCOA_LIMIT ? 'cocoa-seconds' : 'unix-seconds';
}

/** Returns the date as ISO-8601 text, or undefined when the value is not a date this server recognises. */
export function decodeDate(value: JsonValue | undefined): string | undefined {
  const encoding = detectEncoding(value);
  if (encoding === undefined) {
    return undefined;
  }
  if (encoding === 'iso-string') {
    return new Date(Date.parse(asString(value) ?? '')).toISOString();
  }
  const seconds = asNumber(value) ?? 0;
  const unixSeconds = encoding === 'cocoa-seconds' ? seconds + COCOA_EPOCH_OFFSET : seconds;
  return new Date(unixSeconds * 1000).toISOString();
}

export function encodeDate(date: Date, encoding: DateEncoding): JsonValue {
  const unixSeconds = Math.floor(date.getTime() / 1000);
  if (encoding === 'iso-string') {
    return `${date.toISOString().slice(0, 19)}Z`;
  }
  return numberValue(encoding === 'cocoa-seconds' ? unixSeconds - COCOA_EPOCH_OFFSET : unixSeconds);
}
