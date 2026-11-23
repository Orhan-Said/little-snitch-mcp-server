import path from 'node:path';
import { LittleSnitchError } from './errors.js';

export interface Preference {
  readonly key: string;
  readonly value: string;
}

/** Keys whose values are never shown: passwords, keys, licence data. */
const SECRET_KEY = /pass(word|phrase)|secret|token|licen[cs]e|serial|credential|private|(api|encryption)[-_.]?key/i;
export const HIDDEN = '[hidden]';

/**
 * Reads the `key = value` lines of `littlesnitch list-preferences`. A line that
 * does not start a new key continues the value before it.
 */
export function parsePreferences(text: string): readonly Preference[] {
  const preferences: Array<{ key: string; value: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9_.-]+) = (.*)$/.exec(line);
    if (match !== null && match[1] !== undefined) {
      preferences.push({ key: match[1], value: (match[2] ?? '').trim() });
      continue;
    }
    const last = preferences.at(-1);
    if (last !== undefined && line.trim() !== '') {
      last.value = `${last.value}\n${line.trimEnd()}`;
    }
  }
  return preferences.map(({ key, value }) => ({ key, value: SECRET_KEY.test(key) ? HIDDEN : value }));
}

export interface LogEntry {
  readonly time: string;
  readonly process: string;
  readonly type: string;
  readonly message: string;
}

/** Reads the JSON that `littlesnitch log --json` prints and keeps the fields a person reads. */
export function parseLog(text: string): readonly LogEntry[] {
  if (text.trim() === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LittleSnitchError('unexpected-output', "Little Snitch's log was not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new LittleSnitchError('unexpected-output', "Little Snitch's log was not a list of entries.");
  }
  const text_ = (value: unknown): string => (typeof value === 'string' ? value : '');
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return [
      {
        time: text_(record['timestamp']),
        process: path.basename(text_(record['processImagePath'])),
        type: text_(record['messageType']),
        message: text_(record['eventMessage']),
      },
    ];
  });
}
