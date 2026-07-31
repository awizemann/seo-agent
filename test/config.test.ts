import { describe, it, expect } from 'vitest';
import { resolveSiteConfig } from '../src/config';

const MIN = { SITE_URL: 'https://www.example.com/' };

describe('resolveSiteConfig defaults', () => {
  it('derives name/description from the host and leaves optional strings empty', () => {
    const c = resolveSiteConfig(MIN);
    expect(c.siteUrl).toBe('https://www.example.com/');
    expect(c.siteName).toBe('www.example.com');
    expect(c.siteDescription).toBe('the website at www.example.com');
    expect(c.titleBrandSuffix).toBe('');
    expect(c.shellTitle).toBe('');
    expect(c.articlePathPrefix).toBe('');
    expect(c.articleApiTemplate).toBe('');
  });

  it('defaults the behavior knobs', () => {
    const c = resolveSiteConfig(MIN);
    expect(c.aeoChecks).toBe(true);
    expect(c.aeoBotUa).toContain('GPTBot/1.2');
    expect(c.aeoBotUa).toContain('seo-agent-sample');
    expect(c.aiModel).toBe('');
    expect(c.maxProposalsPerRun).toBe(0);
    expect(c.autoApplyFields).toEqual([]);
    expect(c.gscProperty).toBe('');
  });

  it('defaults the citation settings (Monday, no queries, cheapest-first models)', () => {
    const c = resolveSiteConfig(MIN).citations;
    expect(c.queries).toEqual([]);
    expect(c.cronDay).toBe(1);
    expect(c.geminiModel).toBe('gemini-flash-latest');
    expect(c.perplexityModel).toBe('sonar');
    expect(c.openaiModel).toBe('gpt-5-mini');
    expect(c.anthropicModel).toBe('claude-sonnet-5');
  });
});

describe('resolveSiteConfig explicit values', () => {
  it('lets every var win over its default', () => {
    const c = resolveSiteConfig({
      SITE_URL: 'https://acme.test',
      SITE_NAME: 'Acme',
      SITE_DESCRIPTION: 'the Acme storefront',
      TITLE_BRAND_SUFFIX: ' | Acme',
      SHELL_TITLE: 'Acme',
      ARTICLE_PATH_PREFIX: '/articles/',
      ARTICLE_API_TEMPLATE: 'https://acme.test/api/{slug}',
      AEO_BOT_UA: 'MyBot/1.0',
      AI_MODEL: '@cf/meta/llama',
      MAX_PROPOSALS_PER_RUN: '8',
      AUTO_APPLY_FIELDS: 'description, title',
      GSC_PROPERTY: 'sc-domain:acme.test',
      CITATION_GEMINI_MODEL: 'gemini-pro',
      CITATION_PERPLEXITY_MODEL: 'sonar-pro',
      CITATION_OPENAI_MODEL: 'gpt-5',
      CITATION_ANTHROPIC_MODEL: 'claude-opus-5',
    });
    expect(c.siteName).toBe('Acme');
    expect(c.siteDescription).toBe('the Acme storefront');
    expect(c.titleBrandSuffix).toBe(' | Acme');
    expect(c.shellTitle).toBe('Acme');
    expect(c.articlePathPrefix).toBe('/articles/');
    expect(c.articleApiTemplate).toBe('https://acme.test/api/{slug}');
    expect(c.aeoBotUa).toBe('MyBot/1.0');
    expect(c.aiModel).toBe('@cf/meta/llama');
    expect(c.maxProposalsPerRun).toBe(8);
    expect(c.autoApplyFields).toEqual(['description', 'title']);
    expect(c.gscProperty).toBe('sc-domain:acme.test');
    expect(c.citations.geminiModel).toBe('gemini-pro');
    expect(c.citations.perplexityModel).toBe('sonar-pro');
    expect(c.citations.openaiModel).toBe('gpt-5');
    expect(c.citations.anthropicModel).toBe('claude-opus-5');
  });

  it('clamps MAX_PROPOSALS_PER_RUN to a non-negative integer', () => {
    const max = (v: string) => resolveSiteConfig({ ...MIN, MAX_PROPOSALS_PER_RUN: v }).maxProposalsPerRun;
    expect(max('0')).toBe(0);
    expect(max('-3')).toBe(0);
    expect(max('abc')).toBe(0);
    expect(max('')).toBe(0);
    expect(max('12.9')).toBe(12); // parseInt truncates
  });
});

describe('AEO_CHECKS', () => {
  it('is on unless set to a falsy string (case-insensitive)', () => {
    const on = (v?: string) => resolveSiteConfig({ ...MIN, AEO_CHECKS: v }).aeoChecks;
    expect(on(undefined)).toBe(true);
    expect(on('')).toBe(true);
    expect(on('true')).toBe(true);
    expect(on('1')).toBe(true);
    expect(on('no')).toBe(true); // only false/0/off disable
    for (const v of ['false', 'FALSE', '0', 'off', 'Off']) expect(on(v)).toBe(false);
  });
});

describe('citation parsing parity', () => {
  it('parses CITATION_QUERIES as JSON or separated text', () => {
    const q = (v: string) => resolveSiteConfig({ ...MIN, CITATION_QUERIES: v }).citations.queries;
    expect(q('["a", " b "]')).toEqual(['a', 'b']);
    expect(q('a | b\nc')).toEqual(['a', 'b', 'c']);
    expect(q('   ')).toEqual([]);
  });

  it('clamps CITATION_CRON_DAY to a UTC weekday, falling back to Monday', () => {
    const d = (v?: string) => resolveSiteConfig({ ...MIN, CITATION_CRON_DAY: v }).citations.cronDay;
    for (let i = 0; i <= 6; i++) expect(d(String(i))).toBe(i);
    expect(d('7')).toBe(1);
    expect(d('-1')).toBe(1);
    expect(d('abc')).toBe(1);
    expect(d(undefined)).toBe(1);
  });
});
