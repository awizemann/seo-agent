import { describe, it, expect } from 'vitest';
import { decodeEntities, validateTitle } from '../src/rules';

describe('decodeEntities', () => {
  it('decodes the common entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeEntities('say &quot;hi&quot;')).toBe('say "hi"');
    expect(decodeEntities('it&#39;s')).toBe("it's");
    expect(decodeEntities('it&apos;s')).toBe("it's");
  });

  it('decodes &amp; LAST so already-escaped entities are not double-decoded', () => {
    // "&amp;lt;" is a literal "&lt;" — decoding &amp; first would wrongly yield "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeEntities('Tom &amp; Jerry &lt; Spike')).toBe('Tom & Jerry < Spike');
  });
});

describe('validateTitle', () => {
  it('rejects empty / whitespace-only titles', () => {
    expect(validateTitle('')).toBeTruthy();
    expect(validateTitle('   ')).toBeTruthy();
  });

  it('rejects over-long titles (max 80)', () => {
    expect(validateTitle('x'.repeat(81))).toBeTruthy();
    expect(validateTitle('x'.repeat(80))).toBeNull();
  });

  it('accepts a sensible title', () => {
    expect(validateTitle('About Alan Wizemann | Alan Wizemann')).toBeNull();
  });
});
