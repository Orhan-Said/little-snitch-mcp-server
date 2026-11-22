import { LittleSnitchError } from './errors.js';

/** One line of `littlesnitch log-traffic`: traffic of one process to one remote during one interval. */
export interface TrafficRow {
  readonly date: string;
  readonly direction: string;
  readonly uid: string;
  readonly ipAddress: string;
  readonly remoteHostname: string;
  readonly protocol: string;
  readonly port: string;
  readonly connectCount: number;
  readonly denyCount: number;
  readonly byteCountIn: number;
  readonly byteCountOut: number;
  readonly connectingExecutable: string;
  readonly parentAppExecutable: string;
}

/** Splits CSV text into records. Handles quoted fields, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): readonly (readonly string[])[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
      fieldStarted = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      if (fieldStarted || field !== '' || record.length > 0) {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = '';
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (fieldStarted || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const count = (value: string | undefined): number => {
  const number = Number(value ?? '');
  return Number.isFinite(number) ? number : 0;
};

/** Reads the traffic log by its header names, so a change in column order does not break it. */
export function parseTraffic(text: string): readonly TrafficRow[] {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) {
    return [];
  }
  const column = new Map(header.map((name, index) => [name.trim(), index]));
  if (!column.has('date') || !column.has('connectCount')) {
    throw new LittleSnitchError('unexpected-output', `The traffic log does not start with the expected header. It starts with: ${header.join(',').slice(0, 200)}`);
  }
  const get = (record: readonly string[], name: string): string => {
    const index = column.get(name);
    return index === undefined ? '' : (record[index] ?? '');
  };
  return records.slice(1).map((record) => ({
    date: get(record, 'date'),
    direction: get(record, 'direction'),
    uid: get(record, 'uid'),
    ipAddress: get(record, 'ipAddress'),
    remoteHostname: get(record, 'remoteHostname'),
    protocol: get(record, 'protocol'),
    port: get(record, 'port'),
    connectCount: count(get(record, 'connectCount')),
    denyCount: count(get(record, 'denyCount')),
    byteCountIn: count(get(record, 'byteCountIn')),
    byteCountOut: count(get(record, 'byteCountOut')),
    connectingExecutable: get(record, 'connectingExecutable'),
    parentAppExecutable: get(record, 'parentAppExecutable'),
  }));
}

export type TrafficGroupBy = 'app' | 'host' | 'app_and_host' | 'none';
export type TrafficSortBy = 'bytes' | 'connections' | 'denied';

export interface TrafficQuery {
  readonly app?: string;
  readonly host?: string;
  readonly direction?: 'in' | 'out';
  readonly deniedOnly?: boolean;
  readonly groupBy: TrafficGroupBy;
  readonly sortBy: TrafficSortBy;
  readonly limit: number;
}

export interface TrafficEntry {
  readonly app?: string;
  readonly host?: string;
  readonly connections: number;
  readonly denied: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly ports?: readonly string[];
}

export interface TrafficReport {
  readonly totals: { readonly rows: number; readonly connections: number; readonly denied: number; readonly bytesIn: number; readonly bytesOut: number };
  readonly entries: readonly (TrafficEntry | TrafficRow)[];
  /** How many entries matched before the limit was applied. */
  readonly matched: number;
}

/** The app a row belongs to: the responsible app when Little Snitch found one, else the connecting program. */
export const appOf = (row: TrafficRow): string => (row.parentAppExecutable !== '' ? row.parentAppExecutable : row.connectingExecutable);
export const hostOf = (row: TrafficRow): string => (row.remoteHostname !== '' ? row.remoteHostname : row.ipAddress);

const includes = (text: string, part: string): boolean => text.toLowerCase().includes(part.toLowerCase());

function keep(row: TrafficRow, query: TrafficQuery): boolean {
  if (query.app !== undefined && !includes(row.connectingExecutable, query.app) && !includes(row.parentAppExecutable, query.app)) {
    return false;
  }
  if (query.host !== undefined && !includes(row.remoteHostname, query.host) && !includes(row.ipAddress, query.host)) {
    return false;
  }
  if (query.direction !== undefined && row.direction !== query.direction) {
    return false;
  }
  return query.deniedOnly !== true || row.denyCount > 0;
}

const metric = (sortBy: TrafficSortBy): ((entry: TrafficEntry) => number) =>
  sortBy === 'connections' ? (entry) => entry.connections : sortBy === 'denied' ? (entry) => entry.denied : (entry) => entry.bytesIn + entry.bytesOut;

export function summarizeTraffic(rows: readonly TrafficRow[], query: TrafficQuery): TrafficReport {
  const kept = rows.filter((row) => keep(row, query));
  const totals = kept.reduce(
    (sum, row) => ({
      rows: sum.rows + 1,
      connections: sum.connections + row.connectCount,
      denied: sum.denied + row.denyCount,
      bytesIn: sum.bytesIn + row.byteCountIn,
      bytesOut: sum.bytesOut + row.byteCountOut,
    }),
    { rows: 0, connections: 0, denied: 0, bytesIn: 0, bytesOut: 0 },
  );
  if (query.groupBy === 'none') {
    return { totals, entries: kept.slice(-query.limit), matched: kept.length };
  }

  const groups = new Map<string, TrafficEntry & { readonly portSet: ReadonlySet<string> }>();
  for (const row of kept) {
    const app = appOf(row);
    const host = hostOf(row);
    const key = query.groupBy === 'app' ? app : query.groupBy === 'host' ? host : `${app}\u0000${host}`;
    const previous = groups.get(key);
    groups.set(key, {
      ...(query.groupBy === 'host' ? {} : { app }),
      ...(query.groupBy === 'app' ? {} : { host }),
      connections: (previous?.connections ?? 0) + row.connectCount,
      denied: (previous?.denied ?? 0) + row.denyCount,
      bytesIn: (previous?.bytesIn ?? 0) + row.byteCountIn,
      bytesOut: (previous?.bytesOut ?? 0) + row.byteCountOut,
      firstSeen: previous === undefined || row.date < previous.firstSeen ? row.date : previous.firstSeen,
      lastSeen: previous === undefined || row.date > previous.lastSeen ? row.date : previous.lastSeen,
      portSet: new Set([...(previous?.portSet ?? []), ...(row.port === '' ? [] : [row.port])]),
    });
  }
  const score = metric(query.sortBy);
  const entries = [...groups.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, query.limit)
    .map(({ portSet, ...entry }) => ({ ...entry, ports: [...portSet].sort((a, b) => Number(a) - Number(b)).slice(0, 20) }));
  return { totals, entries, matched: groups.size };
}

/** Formats a moment the way `log-traffic` expects it: local time, "YYYY-MM-DD HH:MM:SS". */
export function formatTrafficDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
