import { describe, it, expect } from 'vitest';
import { resolveSiteConfig, findBannedTerm, originReadOrigin, parseOriginFetchBase } from '../src/config';

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

describe('SITE_URL validation', () => {
  it('throws a named domain error when SITE_URL is missing or unparseable', () => {
    expect(() => resolveSiteConfig({})).toThrow('SITE_URL missing or invalid: ""');
    expect(() => resolveSiteConfig({ SITE_URL: '' })).toThrow('SITE_URL missing or invalid: ""');
    expect(() => resolveSiteConfig({ SITE_URL: 'example.com' })).toThrow(
      'SITE_URL missing or invalid: "example.com"',
    );
  });
});

describe('PAGE_CAP', () => {
  it('defaults to 2000 and clamps to [1, 2000]', () => {
    const base = { SITE_URL: 'https://example.com' };
    expect(resolveSiteConfig(base).pageCap).toBe(2000);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '' }).pageCap).toBe(2000);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: 'nope' }).pageCap).toBe(2000);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '0' }).pageCap).toBe(2000);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '-5' }).pageCap).toBe(2000);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '100' }).pageCap).toBe(100);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '1' }).pageCap).toBe(1);
    expect(resolveSiteConfig({ ...base, PAGE_CAP: '99999' }).pageCap).toBe(2000);
  });
});

describe('DRAFTING_GUIDANCE / BANNED_TERMS', () => {
  const base = { SITE_URL: 'https://example.com' };

  it('defaults to no guidance and no terms', () => {
    const c = resolveSiteConfig(base);
    expect(c.draftingGuidance).toBe('');
    expect(c.bannedTerms).toEqual([]);
    expect(resolveSiteConfig({ ...base, DRAFTING_GUIDANCE: '   ', BANNED_TERMS: '  ' }).bannedTerms).toEqual([]);
  });

  it('trims the guidance but otherwise keeps it verbatim', () => {
    expect(resolveSiteConfig({ ...base, DRAFTING_GUIDANCE: '  Refer to the company as Acme.  ' }).draftingGuidance).toBe(
      'Refer to the company as Acme.'
    );
  });

  it('parses BANNED_TERMS as a JSON array', () => {
    expect(resolveSiteConfig({ ...base, BANNED_TERMS: '["Widgetron", " best in class "]' }).bannedTerms).toEqual([
      'Widgetron',
      'best in class',
    ]);
  });

  it('parses BANNED_TERMS as comma- or newline-separated text', () => {
    expect(resolveSiteConfig({ ...base, BANNED_TERMS: 'Widgetron, best in class ,  ' }).bannedTerms).toEqual(['Widgetron', 'best in class']);
    expect(resolveSiteConfig({ ...base, BANNED_TERMS: 'Widgetron\nAcme Corp' }).bannedTerms).toEqual(['Widgetron', 'Acme Corp']);
  });

  it('falls back to separator parsing when the JSON is malformed', () => {
    expect(resolveSiteConfig({ ...base, BANNED_TERMS: '["Widgetron", ' }).bannedTerms).toEqual(['["Widgetron"']);
  });
});

describe('findBannedTerm', () => {
  it('returns null for no text, no terms, or no hit', () => {
    expect(findBannedTerm('', ['a'])).toBeNull();
    expect(findBannedTerm('some text', [])).toBeNull();
    expect(findBannedTerm('some text', undefined)).toBeNull();
    expect(findBannedTerm('some text', ['other'])).toBeNull();
  });

  it('returns the FIRST listed term that matches, in list order', () => {
    expect(findBannedTerm('alpha and beta', ['beta', 'alpha'])).toBe('beta');
    expect(findBannedTerm('alpha and beta', ['gamma', 'alpha'])).toBe('alpha');
  });

  it('is boundary-anchored and case-insensitive', () => {
    expect(findBannedTerm('we maintain things', ['ai'])).toBeNull();
    expect(findBannedTerm('we use AI here', ['ai'])).toBe('ai');
    expect(findBannedTerm('Widgetronic', ['Widgetron'])).toBeNull();
  });

  it('documents the ASCII \\b limit honestly rather than pretending it is not there', () => {
    // Against ASCII text the boundary does its job, and a non-ASCII term is
    // still found on its own and not inside a longer word.
    expect(findBannedTerm('cafeteria', ['cafe'])).toBeNull();
    expect(findBannedTerm('a café serves', ['café'])).toBe('café');
    expect(findBannedTerm('cafés everywhere', ['café'])).toBeNull();
    // The limit: \w is ASCII-only, so a diacritic reads as a word boundary and
    // an ASCII term can end at one and count as a whole word: "na" is a
    // fragment of "naïve", but ï is a non-word character, so \b holds and the
    // term is flagged. Acceptable for brand/competitor lists, and it errs
    // toward over-flagging rather than toward letting a term slip through.
    expect(findBannedTerm('a naïve approach', ['na'])).toBe('na');
    expect(findBannedTerm('a naive approach', ['na'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ORIGIN_FETCH_BASE — origin reads only, and fail-closed means "fall back".
// ---------------------------------------------------------------------------

describe('parseOriginFetchBase', () => {
  it('reduces a valid https base to a bare origin', () => {
    expect(parseOriginFetchBase('https://origin.example.com')).toBe('https://origin.example.com');
    expect(parseOriginFetchBase('  https://origin.example.com/  ')).toBe('https://origin.example.com');
  });

  it('drops path, query, fragment and port survives as part of the origin', () => {
    expect(parseOriginFetchBase('https://origin.example.com/a/b?c=1#d')).toBe('https://origin.example.com');
    expect(parseOriginFetchBase('https://origin.example.com:8443/x')).toBe('https://origin.example.com:8443');
  });

  it('refuses credentials, non-http schemes and garbage — undefined, never a throw', () => {
    expect(parseOriginFetchBase('https://user:pw@origin.example.com')).toBeUndefined();
    expect(parseOriginFetchBase('file:///etc/passwd')).toBeUndefined();
    expect(parseOriginFetchBase('javascript:alert(1)')).toBeUndefined();
    expect(parseOriginFetchBase('origin.example.com')).toBeUndefined();
    expect(parseOriginFetchBase('')).toBeUndefined();
    expect(parseOriginFetchBase(undefined)).toBeUndefined();
  });
});

describe('originFetchBase on SiteConfig', () => {
  it('is ABSENT when the var is unset, so origin reads keep using siteUrl', () => {
    const c = resolveSiteConfig(MIN);
    expect('originFetchBase' in c).toBe(false);
    expect(originReadOrigin(c)).toBe('https://www.example.com');
  });

  it('is the parsed origin when the var is set, and siteUrl is untouched', () => {
    const c = resolveSiteConfig({ ...MIN, ORIGIN_FETCH_BASE: 'https://origin.example.com/ignored' });
    expect(c.originFetchBase).toBe('https://origin.example.com');
    expect(c.siteUrl).toBe('https://www.example.com/');
    expect(originReadOrigin(c)).toBe('https://origin.example.com');
  });

  it('falls back to the site origin on a malformed var rather than throwing', () => {
    const c = resolveSiteConfig({ ...MIN, ORIGIN_FETCH_BASE: 'not a url' });
    expect(c.originFetchBase).toBeUndefined();
    expect(originReadOrigin(c)).toBe('https://www.example.com');
  });
});
