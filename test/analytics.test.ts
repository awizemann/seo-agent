import { describe, it, expect } from 'vitest';
import { pageToPath, pageCandidates } from '../src/pagepath';
import { verdictFor, addDays, windowsFor, type ImpactMetrics } from '../src/impact';
import { weekStartOf } from '../src/telemetry';
import { openFindingsSeries, type FindingRow } from '../src/analytics';

describe('pageToPath', () => {
  const site = 'https://alanwizemann.com';
  it('strips the origin, keeping a leading slash', () => {
    expect(pageToPath('https://alanwizemann.com/articles/x', site)).toBe('/articles/x');
  });
  it('strips a trailing slash except on root', () => {
    expect(pageToPath('https://alanwizemann.com/articles/x/', site)).toBe('/articles/x');
    expect(pageToPath('https://alanwizemann.com/', site)).toBe('/');
    expect(pageToPath('https://alanwizemann.com', site)).toBe('/');
  });
  it('drops query and fragment', () => {
    expect(pageToPath('https://alanwizemann.com/x?utm=1&a=2', site)).toBe('/x');
    expect(pageToPath('https://alanwizemann.com/x/#frag', site)).toBe('/x');
  });
  it('accepts a bare path (already relative)', () => {
    expect(pageToPath('/articles/y/', site)).toBe('/articles/y');
    expect(pageToPath('/', site)).toBe('/');
  });
  it('is origin-agnostic (host on the page does not matter)', () => {
    expect(pageToPath('https://www.other.com/p/', site)).toBe('/p');
  });
  it('collapses redundant trailing slashes', () => {
    expect(pageToPath('https://alanwizemann.com/a///', site)).toBe('/a');
  });
});

describe('pageCandidates', () => {
  const site = 'https://alanwizemann.com';
  it('returns both slash variants for a normal path', () => {
    expect(pageCandidates('/articles/x', site)).toEqual([
      'https://alanwizemann.com/articles/x',
      'https://alanwizemann.com/articles/x/',
    ]);
  });
  it('handles root', () => {
    expect(pageCandidates('/', site)).toEqual(['https://alanwizemann.com/', 'https://alanwizemann.com']);
  });
});

describe('addDays / windowsFor', () => {
  it('adds and subtracts UTC days across month boundaries', () => {
    expect(addDays('2026-07-19', 1)).toBe('2026-07-20');
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('d14 windows: 14 full days before, 3-day settle gap, 14-day after ending A+17', () => {
    const w = windowsFor('2026-07-15', 'd14');
    expect(w.beforeStart).toBe('2026-07-01'); // A-14
    expect(w.beforeEnd).toBe('2026-07-14'); // A-1
    expect(w.afterStart).toBe('2026-07-19'); // A+4
    expect(w.afterEnd).toBe('2026-08-01'); // A+17
  });
  it('d28 windows: 28-day windows, after ends A+31', () => {
    const w = windowsFor('2026-07-15', 'd28');
    expect(w.beforeStart).toBe('2026-06-17'); // A-28
    expect(w.beforeEnd).toBe('2026-07-14'); // A-1
    expect(w.afterStart).toBe('2026-07-19'); // A+4
    expect(w.afterEnd).toBe('2026-08-15'); // A+31
  });
});

// Base metrics: enough impressions, no strong movement → neutral. Each test
// perturbs one axis. Rates are per-day; days chosen so rate*days is exact.
const base = (): ImpactMetrics => ({
  before_clicks: 10,
  after_clicks: 10,
  before_impressions: 100,
  after_impressions: 100,
  before_ctr: 0.1,
  after_ctr: 0.1,
  before_position: 5,
  after_position: 5,
  before_days: 14,
  after_days: 14,
});

describe('verdictFor', () => {
  it('neutral when nothing moves', () => {
    expect(verdictFor(base())).toBe('neutral');
  });

  it('insufficient_data when a window has zero days', () => {
    expect(verdictFor({ ...base(), before_days: 0 })).toBe('insufficient_data');
    expect(verdictFor({ ...base(), after_days: 0 })).toBe('insufficient_data');
  });

  it('insufficient_data when total impressions < 50', () => {
    // 1/day * 14 + 1/day * 14 = 28 total impressions < 50.
    const m = { ...base(), before_impressions: 1, after_impressions: 1 };
    expect(verdictFor(m)).toBe('insufficient_data');
  });

  it('helped on a CTR rise >= +15%', () => {
    expect(verdictFor({ ...base(), before_ctr: 0.1, after_ctr: 0.12 })).toBe('helped'); // +20%
  });
  it('does not fire on a CTR rise just under +15%', () => {
    expect(verdictFor({ ...base(), before_ctr: 0.1, after_ctr: 0.114 })).toBe('neutral'); // +14%
  });
  it('hurt on a CTR drop <= -15%', () => {
    expect(verdictFor({ ...base(), before_ctr: 0.1, after_ctr: 0.08 })).toBe('hurt'); // -20%
  });

  it('helped on a position improvement >= 1.0 with impressions holding', () => {
    expect(verdictFor({ ...base(), before_position: 8, after_position: 6.5 })).toBe('helped');
  });
  it('position improvement ignored when impressions collapse >20%', () => {
    // position better by 1.5 but impressions down 40% → not helped (→ neutral).
    expect(verdictFor({ ...base(), before_position: 8, after_position: 6.5, before_impressions: 100, after_impressions: 60 })).toBe('neutral');
  });
  it('hurt on a position worsening >= 1.0 without an impression surge', () => {
    expect(verdictFor({ ...base(), before_position: 6, after_position: 7.5 })).toBe('hurt');
  });
  it('position worsening ignored when impressions surge >20% (volume dilution)', () => {
    expect(verdictFor({ ...base(), before_position: 6, after_position: 7.5, before_impressions: 100, after_impressions: 130 })).toBe('neutral');
  });

  it('guards a zero before_ctr denominator (no divide-by-zero, no false helped)', () => {
    const m = { ...base(), before_ctr: 0, after_ctr: 0.2 };
    expect(verdictFor(m)).toBe('neutral'); // CTR branch skipped, position flat
  });
  it('guards zero positions (0 = no data, not rank 0)', () => {
    const m = { ...base(), before_position: 0, after_position: 0 };
    expect(verdictFor(m)).toBe('neutral');
  });

  it('conflicting helped+hurt signals resolve to neutral', () => {
    // CTR up 20% (helped) but position worsens 2.0 with flat impressions (hurt).
    const m = { ...base(), before_ctr: 0.1, after_ctr: 0.12, before_position: 6, after_position: 8 };
    expect(verdictFor(m)).toBe('neutral');
  });
});

describe('weekStartOf', () => {
  it('returns the ISO Monday (UTC) of the week', () => {
    expect(weekStartOf('2026-07-19T12:00:00Z')).toBe('2026-07-13'); // Sun → prior Mon
    expect(weekStartOf('2026-07-13T00:00:00Z')).toBe('2026-07-13'); // Mon → itself
    expect(weekStartOf('2026-07-14T23:59:59Z')).toBe('2026-07-13'); // Tue
    expect(weekStartOf('2026-07-18T09:00:00Z')).toBe('2026-07-13'); // Sat
  });
  it('crosses a month boundary correctly', () => {
    expect(weekStartOf('2026-08-02T06:00:00Z')).toBe('2026-07-27'); // Sun → prior Mon in July
  });
});

describe('openFindingsSeries', () => {
  const today = new Date().toISOString().slice(0, 10);
  const d = (n: number) => {
    const x = new Date(today + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  it('counts a still-open finding on every day from creation onward', () => {
    const rows: FindingRow[] = [{ created_at: d(-2) + 'T00:00:00Z', resolved_at: null, severity: 'high' }];
    const s = openFindingsSeries(rows, 5);
    expect(s.length).toBe(5);
    expect(s[s.length - 1].date).toBe(today);
    expect(s[0].total).toBe(0); // d(-4): before creation
    expect(s[2].total).toBe(1); // d(-2): created
    expect(s[4].counts.high).toBe(1);
  });

  it('closes a finding on and after its resolved day (resolved > D)', () => {
    const rows: FindingRow[] = [{ created_at: d(-4) + 'T00:00:00Z', resolved_at: d(-2) + 'T00:00:00Z', severity: 'medium' }];
    const s = openFindingsSeries(rows, 5); // days d(-4)..d(0)
    expect(s[0].total).toBe(1); // d(-4) created, open
    expect(s[1].total).toBe(1); // d(-3) open
    expect(s[2].total).toBe(0); // d(-2) resolved → closed
    expect(s[3].total).toBe(0);
  });

  it('groups by severity', () => {
    const rows: FindingRow[] = [
      { created_at: d(-1) + 'T00:00:00Z', resolved_at: null, severity: 'high' },
      { created_at: d(-1) + 'T00:00:00Z', resolved_at: null, severity: 'info' },
    ];
    const s = openFindingsSeries(rows, 2);
    expect(s[s.length - 1].counts.high).toBe(1);
    expect(s[s.length - 1].counts.info).toBe(1);
    expect(s[s.length - 1].total).toBe(2);
  });
});
