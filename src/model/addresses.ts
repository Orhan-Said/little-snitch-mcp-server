/**
 * Reads the entries of a rule's address list (an address, a network a/prefix,
 * or a range a-b) as spans of numbers, so that the server can tell when a list
 * covers every address of a family. Such a list is "any remote" by another name.
 */

export type AddressFamily = 'IPv4' | 'IPv6';

export interface AddressSpan {
  readonly family: AddressFamily;
  /** The first address, as a number. */
  readonly start: bigint;
  /** The last address, as a number. */
  readonly end: bigint;
}

const BITS: Readonly<Record<AddressFamily, bigint>> = { IPv4: 32n, IPv6: 128n };
const FAMILIES: readonly AddressFamily[] = ['IPv4', 'IPv6'];
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const GROUP = /^[0-9a-f]{1,4}$/i;

function parseIPv4(text: string): bigint | undefined {
  const match = IPV4.exec(text);
  if (match === null) {
    return undefined;
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) {
    return undefined;
  }
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

/** Reads the full and the shortened (::) forms. No zone index, no IPv4 tail. */
function parseIPv6(text: string): bigint | undefined {
  if (text.length > 39 || !/^[0-9a-f:]+$/i.test(text)) {
    return undefined;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const groupsOf = (part: string): readonly string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (![...head, ...tail].every((group) => GROUP.test(group))) {
    return undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function parseSingle(text: string): { readonly family: AddressFamily; readonly value: bigint } | undefined {
  const v4 = parseIPv4(text);
  if (v4 !== undefined) {
    return { family: 'IPv4', value: v4 };
  }
  const v6 = text.includes(':') ? parseIPv6(text) : undefined;
  return v6 === undefined ? undefined : { family: 'IPv6', value: v6 };
}

/** The addresses one entry covers, or undefined when the entry is not an address, a network or a range. */
export function parseAddressSpan(value: string): AddressSpan | undefined {
  if (value.includes('/')) {
    const [address, prefix, ...rest] = value.split('/');
    const base = rest.length === 0 && address !== undefined ? parseSingle(address) : undefined;
    if (base === undefined || !/^\d{1,3}$/.test(prefix ?? '')) {
      return undefined;
    }
    const bits = BigInt(Number(prefix));
    const width = BITS[base.family];
    if (bits > width) {
      return undefined;
    }
    const hostBits = width - bits;
    const start = (base.value >> hostBits) << hostBits;
    return { family: base.family, start, end: start | ((1n << hostBits) - 1n) };
  }
  if (value.includes('-')) {
    const [from, to, ...rest] = value.split('-');
    const first = rest.length === 0 && from !== undefined ? parseSingle(from) : undefined;
    const last = to === undefined ? undefined : parseSingle(to);
    if (first === undefined || last === undefined || first.family !== last.family || first.value > last.value) {
      return undefined;
    }
    return { family: first.family, start: first.value, end: last.value };
  }
  const single = parseSingle(value);
  return single === undefined ? undefined : { family: single.family, start: single.value, end: single.value };
}

function coversWhole(spans: readonly AddressSpan[], family: AddressFamily): boolean {
  const last = (1n << BITS[family]) - 1n;
  const sorted = spans.filter((span) => span.family === family).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  // `next` is the first address not covered yet. A span that starts after it leaves a gap.
  const next = sorted.reduce<bigint | undefined>((reach, span) => {
    if (reach === undefined || span.start > reach) {
      return undefined;
    }
    return span.end + 1n > reach ? span.end + 1n : reach;
  }, 0n);
  return next !== undefined && next > last;
}

/**
 * The address families whose every address the entries cover together, in
 * the order IPv4, IPv6. Entries that are not addresses are left out; the rule
 * check refuses them before this matters.
 */
export function familiesCoveredWhole(entries: readonly string[]): readonly AddressFamily[] {
  const spans = entries.map(parseAddressSpan).filter((span): span is AddressSpan => span !== undefined);
  return FAMILIES.filter((family) => coversWhole(spans, family));
}
