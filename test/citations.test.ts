import { describe, it, expect } from 'vitest';
import { parseQueries, matchSite, clampCronDay } from '../src/citations';

describe('parseQueries', () => {
  it('parses a JSON array', () => {
    expect(parseQueries('["a", "b", " c "]')).toEqual(['a', 'b', 'c']);
  });
  it('parses pipe- and newline-separated text', () => {
    expect(parseQueries('a | b | c')).toEqual(['a', 'b', 'c']);
    expect(parseQueries('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for empty / whitespace', () => {
    expect(parseQueries('')).toEqual([]);
    expect(parseQueries('   ')).toEqual([]);
  });
  it('falls back to separator parsing on malformed JSON', () => {
    expect(parseQueries('[oops | b')).toEqual(['[oops', 'b']);
  });
});

describe('matchSite', () => {
  it('matches the site host via the domain field', () => {
    const r = matchSite([{ domain: 'other.com' }, { domain: 'alanwizemann.com', url: 'https://alanwizemann.com/x' }], 'alanwizemann.com');
    expect(r.rank).toBe(2);
    expect(r.url).toBe('https://alanwizemann.com/x');
  });
  it('matches a subdomain and ignores www', () => {
    expect(matchSite([{ url: 'https://www.alanwizemann.com/a' }], 'alanwizemann.com').rank).toBe(1);
    expect(matchSite([{ url: 'https://eo.alanwizemann.com/a' }], 'alanwizemann.com').rank).toBe(1);
  });
  it('returns null rank when not cited', () => {
    expect(matchSite([{ url: 'https://example.org' }], 'alanwizemann.com').rank).toBeNull();
  });
  it('does not match an unrelated host that merely ends with the name', () => {
    expect(matchSite([{ url: 'https://notalanwizemann.com' }], 'alanwizemann.com').rank).toBeNull();
  });
});

describe('clampCronDay', () => {
  it('accepts 0..6', () => {
    for (let d = 0; d <= 6; d++) expect(clampCronDay(String(d))).toBe(d);
  });
  it('defaults out-of-range / non-numeric to Monday (1)', () => {
    expect(clampCronDay('7')).toBe(1); // getUTCDay() never returns 7 — the reported bug
    expect(clampCronDay('-1')).toBe(1);
    expect(clampCronDay('abc')).toBe(1);
    expect(clampCronDay('')).toBe(1);
    expect(clampCronDay(undefined)).toBe(1);
    expect(clampCronDay('3.9')).toBe(3); // parseInt truncates to 3, in range
  });
});
