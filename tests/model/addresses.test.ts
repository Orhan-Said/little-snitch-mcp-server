import { describe, expect, it } from 'vitest';
import { familiesCoveredWhole, parseAddressSpan } from '../../src/model/addresses.js';

const IPV4_LAST = 2n ** 32n - 1n;
const IPV6_LAST = 2n ** 128n - 1n;

describe('parseAddressSpan', () => {
  it('reads a single address as a span of one', () => {
    expect(parseAddressSpan('192.168.1.10')).toEqual({ family: 'IPv4', start: 3_232_235_786n, end: 3_232_235_786n });
    expect(parseAddressSpan('fe80::1')).toEqual({ family: 'IPv6', start: 0xfe80n << 112n | 1n, end: 0xfe80n << 112n | 1n });
    expect(parseAddressSpan('::')).toEqual({ family: 'IPv6', start: 0n, end: 0n });
  });

  it('reads a network as every address its prefix covers', () => {
    expect(parseAddressSpan('10.0.0.0/8')).toEqual({ family: 'IPv4', start: 167_772_160n, end: 184_549_375n });
    expect(parseAddressSpan('10.1.2.3/8')).toEqual({ family: 'IPv4', start: 167_772_160n, end: 184_549_375n });
    expect(parseAddressSpan('0.0.0.0/0')).toEqual({ family: 'IPv4', start: 0n, end: IPV4_LAST });
    expect(parseAddressSpan('::/0')).toEqual({ family: 'IPv6', start: 0n, end: IPV6_LAST });
    expect(parseAddressSpan('2001:db8::/32')).toEqual({ family: 'IPv6', start: 0x20010db8n << 96n, end: (0x20010db8n << 96n) | (2n ** 96n - 1n) });
  });

  it('reads a range from its first to its last address', () => {
    expect(parseAddressSpan('192.168.1.1-192.168.1.9')).toEqual({ family: 'IPv4', start: 3_232_235_777n, end: 3_232_235_785n });
    expect(parseAddressSpan('0.0.0.0-255.255.255.255')).toEqual({ family: 'IPv4', start: 0n, end: IPV4_LAST });
  });

  it('refuses what is not an address, a network or a range', () => {
    for (const value of [
      '999.1.1.1',
      '10.0.0.0/33',
      '10.0.0.0/64',
      'fe80::/129',
      '10.0.0.0/',
      '10.0.0.0/8/8',
      ':::',
      '1:2',
      '1::2::3',
      '12345::1',
      '1:2:3:4:5:6:7:8:9',
      '1111:2222:3333:4444:5555:6666:7777:8888:9',
      'fe80::g1',
      'fe80::1%en0',
      '1.2.3.4-::1',
      '10.0.0.9-10.0.0.1',
      '10.0.0.1-',
      'example.com',
      '',
    ]) {
      expect(parseAddressSpan(value), value).toBeUndefined();
    }
  });
});

describe('familiesCoveredWhole', () => {
  it('names a family that one entry covers whole', () => {
    expect(familiesCoveredWhole(['0.0.0.0/0'])).toEqual(['IPv4']);
    expect(familiesCoveredWhole(['::/0'])).toEqual(['IPv6']);
    expect(familiesCoveredWhole(['0.0.0.0/0', '::/0'])).toEqual(['IPv4', 'IPv6']);
    expect(familiesCoveredWhole(['0.0.0.0-255.255.255.255'])).toEqual(['IPv4']);
  });

  it('names a family that several entries cover together, in any order and overlapping', () => {
    expect(familiesCoveredWhole(['128.0.0.0/1', '0.0.0.0/1'])).toEqual(['IPv4']);
    expect(familiesCoveredWhole(['0.0.0.0-127.255.255.255', '128.0.0.0-255.255.255.255'])).toEqual(['IPv4']);
    expect(familiesCoveredWhole(['0.0.0.0/2', '0.0.0.0/1', '100.0.0.0-255.255.255.255'])).toEqual(['IPv4']);
    expect(familiesCoveredWhole(['8000::/1', '::/1'])).toEqual(['IPv6']);
  });

  it('names nothing when one address is left out', () => {
    expect(familiesCoveredWhole(['0.0.0.0/1'])).toEqual([]);
    expect(familiesCoveredWhole(['0.0.0.0-127.255.255.254', '128.0.0.0/1'])).toEqual([]);
    expect(familiesCoveredWhole(['0.0.0.1-255.255.255.255'])).toEqual([]);
    expect(familiesCoveredWhole(['0.0.0.0-255.255.255.254'])).toEqual([]);
    expect(familiesCoveredWhole(['10.0.0.0/8', 'fe80::1', '192.168.0.0/16'])).toEqual([]);
    expect(familiesCoveredWhole([])).toEqual([]);
  });

  it('does not count an IPv4 network toward IPv6, or the other way round', () => {
    expect(familiesCoveredWhole(['0.0.0.0/0', '::/1'])).toEqual(['IPv4']);
  });

  it('ignores an entry it cannot read, which the rule check refuses anyway', () => {
    expect(familiesCoveredWhole(['not an address', '0.0.0.0/1'])).toEqual([]);
  });
});
