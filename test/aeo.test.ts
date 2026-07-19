import { describe, it, expect } from 'vitest';
import { parseRobots, robotsDecision, hasExplicitAiPolicy, pickSample, dayOfYear } from '../src/aeo';

describe('parseRobots + robotsDecision', () => {
  const txt = `
User-agent: *
Disallow: /admin

User-agent: GPTBot
Disallow: /

User-agent: Googlebot
Allow: /
Disallow: /private
`;
  const groups = parseRobots(txt);

  it('blocks a bot disallowed at /', () => {
    expect(robotsDecision(groups, 'GPTBot', '/')).toBe('block');
  });
  it('is case-insensitive on the agent token', () => {
    expect(robotsDecision(groups, 'gptbot', '/')).toBe('block');
  });
  it('allows a bot with an explicit Allow: / (longest match wins)', () => {
    expect(robotsDecision(groups, 'Googlebot', '/')).toBe('allow');
    expect(robotsDecision(groups, 'Googlebot', '/private')).toBe('block');
  });
  it('falls back to the * group for unnamed bots', () => {
    expect(robotsDecision(groups, 'RandomBot', '/')).toBe('allow');
    expect(robotsDecision(groups, 'RandomBot', '/admin')).toBe('block');
  });
  it('allows everything when robots names no matching group', () => {
    expect(robotsDecision(parseRobots('Sitemap: https://x/s.xml'), 'GPTBot', '/')).toBe('allow');
  });
  it('treats an empty Disallow: as allow-all', () => {
    expect(robotsDecision(parseRobots('User-agent: *\nDisallow:'), 'AnyBot', '/')).toBe('allow');
  });
});

describe('hasExplicitAiPolicy', () => {
  it('is true when a known AI bot is named', () => {
    expect(hasExplicitAiPolicy(parseRobots('User-agent: PerplexityBot\nDisallow:'))).toBe(true);
  });
  it('is false when only generic agents appear', () => {
    expect(hasExplicitAiPolicy(parseRobots('User-agent: *\nDisallow: /'))).toBe(false);
  });
});

describe('pickSample (deliverability rotation)', () => {
  const pool = ['a', 'b', 'c', 'd'];
  it('picks count items from the offset, wrapping around', () => {
    expect(pickSample(pool, 3, 0)).toEqual(['a', 'b', 'c']);
    expect(pickSample(pool, 3, 1)).toEqual(['b', 'c', 'd']);
    expect(pickSample(pool, 3, 3)).toEqual(['d', 'a', 'b']);
  });
  it('normalizes offsets larger than the pool', () => {
    expect(pickSample(pool, 2, 4)).toEqual(['a', 'b']); // 4 % 4 === 0
    expect(pickSample(pool, 2, 5)).toEqual(['b', 'c']);
  });
  it('never returns more than the pool size, and handles empty', () => {
    expect(pickSample(['x', 'y'], 3, 0)).toEqual(['x', 'y']);
    expect(pickSample([], 3, 0)).toEqual([]);
  });
});

describe('dayOfYear', () => {
  it('is 1 on Jan 1 and 365 on Dec 31 (non-leap)', () => {
    expect(dayOfYear(new Date('2026-01-01T12:00:00Z'))).toBe(1);
    expect(dayOfYear(new Date('2026-12-31T00:00:00Z'))).toBe(365);
  });
});
