import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LittleSnitchError, toErrorPayload } from '../src/errors.js';
import { parseLog, parsePreferences } from '../src/readouts.js';
import { createStore } from '../src/store.js';
import { appOf, formatTrafficDate, hostOf, parseCsv, parseTraffic, summarizeTraffic } from '../src/traffic.js';
import { TRAFFIC_CSV } from './helpers/harness.js';

describe('parseCsv', () => {
  it('splits plain records', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quotes, doubled quotes, commas and line breaks inside a field', () => {
    expect(parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\n')).toEqual([['name', 'note'], ['Smith, J', 'said "hi"\nthen left']]);
  });

  it('keeps empty fields, accepts CRLF and a missing final line break', () => {
    expect(parseCsv('a,,c\r\n,,\r\nx,y,z')).toEqual([['a', '', 'c'], ['', '', ''], ['x', 'y', 'z']]);
  });

  it('returns nothing for empty text', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('parseTraffic', () => {
  it('reads rows by header name whatever the column order', () => {
    const rows = parseTraffic('connectCount,date,remoteHostname,byteCountIn\n3,2026-11-22 10:00:00,example.com,1024\n');
    expect(rows).toEqual([
      {
        date: '2026-11-22 10:00:00', direction: '', uid: '', ipAddress: '', remoteHostname: 'example.com', protocol: '', port: '',
        connectCount: 3, denyCount: 0, byteCountIn: 1024, byteCountOut: 0, connectingExecutable: '', parentAppExecutable: '',
      },
    ]);
  });

  it('returns no rows for a header alone and for nothing at all', () => {
    expect(parseTraffic(TRAFFIC_CSV.split('\n')[0] ?? '')).toEqual([]);
    expect(parseTraffic('')).toEqual([]);
  });

  it('refuses text that is not the traffic log', () => {
    expect(() => parseTraffic('Error: something went wrong\n')).toThrow(LittleSnitchError);
  });
});

describe('summarizeTraffic', () => {
  const rows = parseTraffic(TRAFFIC_CSV);

  it('names the responsible app when there is one, and the address when there is no host name', () => {
    expect(appOf(rows[2]!)).toBe('/Applications/Safari.app/Contents/MacOS/Safari');
    expect(appOf(rows[0]!)).toBe('/Applications/Slack.app/Contents/MacOS/Slack');
    expect(hostOf(rows[4]!)).toBe('192.168.1.20');
  });

  it('groups by app and sorts by connections', () => {
    const report = summarizeTraffic(rows, { groupBy: 'app', sortBy: 'connections', limit: 2 });
    expect(report.matched).toBe(3);
    expect(report.entries).toEqual([
      { app: '/Applications/Slack.app/Contents/MacOS/Slack', connections: 5, denied: 5, bytesIn: 20000, bytesOut: 4000, firstSeen: '2026-11-22 19:10:00', lastSeen: '2026-11-22 19:40:00', ports: ['443'] },
      { app: '/usr/sbin/mDNSResponder', connections: 4, denied: 0, bytesIn: 300, bytesOut: 0, firstSeen: '2026-11-22 19:50:00', lastSeen: '2026-11-22 19:50:00', ports: ['5353'] },
    ]);
  });

  it('filters by host name or address', () => {
    expect(summarizeTraffic(rows, { host: '192.168', groupBy: 'host', sortBy: 'bytes', limit: 10 }).totals.rows).toBe(1);
    expect(summarizeTraffic(rows, { host: 'SLACK', groupBy: 'host', sortBy: 'bytes', limit: 10 }).totals.rows).toBe(3);
  });

  it('returns the most recent raw rows when not grouping', () => {
    const report = summarizeTraffic(rows, { groupBy: 'none', sortBy: 'bytes', limit: 2 });
    expect(report.matched).toBe(5);
    expect(report.entries.map((entry) => ('date' in entry ? entry.date : ''))).toEqual(['2026-11-22 19:40:00', '2026-11-22 19:50:00']);
  });
});

describe('formatTrafficDate', () => {
  it('writes local time as YYYY-MM-DD HH:MM:SS', () => {
    expect(formatTrafficDate(new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05 07:08:09');
  });
});

describe('parsePreferences', () => {
  it('hides every value whose key looks secret', () => {
    const preferences = parsePreferences('  apiToken = abc\n  userPassword = hunter2\n  LicenseOwner = Someone\n  plain = 1\n');
    expect(preferences.map((entry) => entry.value)).toEqual(['[hidden]', '[hidden]', '[hidden]', '1']);
  });

  it('ignores lines before the first key', () => {
    expect(parsePreferences('Preferences:\n  a = 1\n')).toEqual([{ key: 'a', value: '1' }]);
  });
});

describe('parseLog', () => {
  it('returns nothing for empty output and refuses output that is not a list', () => {
    expect(parseLog('')).toEqual([]);
    expect(() => parseLog('not json')).toThrow(/not valid JSON/);
    expect(() => parseLog('{"a":1}')).toThrow(/not a list/);
  });

  it('skips entries that are not objects', () => {
    expect(parseLog('[1, {"timestamp":"t","processImagePath":"/a/b/Tool","messageType":"Default","eventMessage":"m"}]')).toEqual([
      { time: 't', process: 'Tool', type: 'Default', message: 'm' },
    ]);
  });
});

describe('toErrorPayload', () => {
  it('carries the kind, message, remedy and details of a known error', () => {
    const error = new LittleSnitchError('not-found', 'No such rule.', { remedy: 'List the rules again.', details: { ref: 'r1' } });
    expect(toErrorPayload(error)).toEqual({ kind: 'not-found', message: 'No such rule.', remedy: 'List the rules again.', details: { ref: 'r1' } });
  });

  it('reports anything else as internal', () => {
    expect(toErrorPayload(new Error('boom'))).toEqual({ kind: 'internal', message: 'boom' });
    expect(toErrorPayload('plain')).toEqual({ kind: 'internal', message: 'plain' });
  });
});

describe('createStore', () => {
  let dir: string | undefined;
  const fresh = (): string => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lsmcp-store-'));
    return path.join(dir, 'data');
  };
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the 50 newest backups and removes older ones', async () => {
    let tick = 0;
    const store = createStore(fresh(), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    for (let i = 0; i < 53; i += 1) {
      await store.writeBackup(`{"n":${i}}`, 'auto');
    }
    const backups = await store.listBackups();
    expect(backups).toHaveLength(50);
    expect(readFileSync(backups[0]!.path, 'utf8')).toBe('{"n":52}');
    expect(readFileSync(backups.at(-1)!.path, 'utf8')).toBe('{"n":3}');
  });

  it('ignores files in the backup folder that it did not make', async () => {
    const dataDir = fresh();
    const store = createStore(dataDir, () => new Date('2026-11-22T16:00:00Z'));
    const backup = await store.writeBackup('{}', 'x');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dataDir, 'backups', 'notes.txt'), 'hello');
    expect((await store.listBackups()).map((entry) => entry.name)).toEqual([backup.name]);
    await expect(store.readBackup('notes.txt')).rejects.toMatchObject({ kind: 'invalid-input' });
  });

  it('writes pending files privately and removes only its own', async () => {
    const dataDir = fresh();
    const store = createStore(dataDir);
    const pending = await store.writePending('{"rules":[]}');
    expect(statSync(pending).mode & 0o777).toBe(0o600);
    await store.removePending(path.join(dataDir, 'backups', 'other.json'));
    await store.removePending(pending);
    expect(readdirSync(path.join(dataDir, 'pending'))).toEqual([]);
  });

  it('appends one line per change to a private log', async () => {
    const dataDir = fresh();
    const store = createStore(dataDir, () => new Date('2026-11-22T16:00:00Z'));
    await store.audit({ tool: 'add_rule', summary: 'one', outcome: 'applied' });
    await store.audit({ tool: 'remove_rule', summary: 'two', outcome: 'failed' });
    const file = path.join(dataDir, 'changes.log');
    expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { time: '2026-11-22T16:00:00.000Z', tool: 'add_rule', summary: 'one', outcome: 'applied' },
      { time: '2026-11-22T16:00:00.000Z', tool: 'remove_rule', summary: 'two', outcome: 'failed' },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
