import { describe, it, expect } from 'vitest';
import { parseSitemap, dedupeAndCap } from '../src/crawl';

const ORIGIN = 'https://example.com';

describe('parseSitemap', () => {
  it('parses a <urlset> into entries (same-origin only)', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url>
      <url><loc>https://example.com/b</loc></url>
      <url><loc>https://other.com/c</loc></url>
    </urlset>`;
    const { entries, sitemaps } = parseSitemap(xml, ORIGIN);
    expect(entries).toEqual([
      { loc: 'https://example.com/a', lastmod: '2026-01-01' },
      { loc: 'https://example.com/b', lastmod: null },
    ]);
    expect(sitemaps).toEqual([]);
  });

  it('parses a <sitemapindex> into child sitemap locations', () => {
    const xml = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
      <sitemap><loc>https://cdn.other.com/s.xml</loc></sitemap>
    </sitemapindex>`;
    const { entries, sitemaps } = parseSitemap(xml, ORIGIN);
    expect(entries).toEqual([]);
    expect(sitemaps).toEqual(['https://example.com/sitemap-1.xml', 'https://example.com/sitemap-2.xml']);
  });
});

describe('dedupeAndCap', () => {
  it('dedupes by loc, keeping first occurrence', () => {
    const { entries, truncated } = dedupeAndCap(
      [
        { loc: 'https://example.com/a', lastmod: '1' },
        { loc: 'https://example.com/a', lastmod: '2' },
        { loc: 'https://example.com/b', lastmod: null },
      ],
      2000
    );
    expect(entries.map((e) => e.loc)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(entries[0].lastmod).toBe('1');
    expect(truncated).toBe(false);
  });

  it('caps the total and flags truncation', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ loc: `https://example.com/${i}`, lastmod: null }));
    const { entries, truncated } = dedupeAndCap(many, 3);
    expect(entries).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});
