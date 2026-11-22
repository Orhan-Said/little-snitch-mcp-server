import { createHash } from 'node:crypto';
import { isLosslessNumber, LosslessNumber, parse, stringify } from 'lossless-json';
import { LittleSnitchError } from '../errors.js';

/**
 * Little Snitch's configuration is read and written back as a whole. Numbers
 * are kept exactly as written (`LosslessNumber`), so a value this server does
 * not understand, such as a 64-bit integer, survives the round trip unchanged.
 */
export type JsonValue = null | boolean | string | LosslessNumber | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isLosslessNumber(value);
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
  if (!isLosslessNumber(value)) {
    return undefined;
  }
  const number = Number(value.value);
  return Number.isFinite(number) ? number : undefined;
}

export function isNumber(value: JsonValue | undefined): value is LosslessNumber {
  return isLosslessNumber(value);
}

export function numberValue(value: number): LosslessNumber {
  return new LosslessNumber(String(value));
}

/** Parses the text `littlesnitch export-model` prints. */
export function parseModelText(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new LittleSnitchError('unexpected-output', `Little Snitch's configuration is not valid JSON: ${(error as Error).message.slice(0, 200)}`);
  }
  const value = parsed as JsonValue;
  if (!isObject(value)) {
    throw new LittleSnitchError('unexpected-output', "Little Snitch's configuration is not a JSON object.");
  }
  if (value['rules'] !== undefined && !Array.isArray(value['rules'])) {
    throw new LittleSnitchError('unexpected-output', 'The "rules" entry of the configuration is not a list. This version of Little Snitch is not supported yet.');
  }
  return value;
}

export function serializeModel(model: JsonObject): string {
  const text = stringify(model);
  if (text === undefined) {
    throw new Error('The configuration could not be serialized.');
  }
  return text;
}

/** Converts to ordinary JSON for output. A number too large or precise for JavaScript is given as text. */
export function toPlain(value: JsonValue | undefined): unknown {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value ?? null;
  }
  if (isLosslessNumber(value)) {
    const number = Number(value.value);
    return Number.isFinite(number) && String(number) === normalizeLexeme(value.value) ? number : value.value;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlain(entry)]));
}

function normalizeLexeme(lexeme: string): string {
  const number = Number(lexeme);
  if (!Number.isFinite(number)) {
    return lexeme;
  }
  const isInteger = /^-?\d+$/.test(lexeme);
  if (isInteger && !Number.isSafeInteger(number)) {
    return lexeme;
  }
  return String(number);
}

/** A stable text form: keys sorted, numbers normalized. Two values are the same exactly when their forms are equal. */
export function canonical(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (isLosslessNumber(value)) {
    return normalizeLexeme(value.value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function without(object: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

/** Every entry of the rule list exactly as it is, including any this server cannot read. Use it when writing the list back. */
export function rawRules(model: JsonObject): readonly JsonValue[] {
  const rules = model['rules'];
  return Array.isArray(rules) ? rules : [];
}

export function rulesOf(model: JsonObject): readonly JsonObject[] {
  const rules = model['rules'];
  return Array.isArray(rules) ? rules.filter(isObject) : [];
}
