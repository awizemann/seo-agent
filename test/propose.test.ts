import { describe, it, expect } from 'vitest';
import { invalidReason } from '../src/propose';

describe('invalidReason (description validation)', () => {
  const ok = 'This is a plainly written meta description that lands comfortably within the seventy to one-sixty character band.';

  it('accepts a well-formed description', () => {
    expect(invalidReason(ok)).toBeNull();
  });
  it('rejects too-short copy (< 70 chars)', () => {
    expect(invalidReason('Too short.')).toMatch(/too short/);
  });
  it('rejects too-long copy (> 160 chars)', () => {
    expect(invalidReason('a'.repeat(170) + '.')).toMatch(/too long/);
  });
  it('rejects copy that does not end in sentence punctuation', () => {
    expect(invalidReason('a'.repeat(100))).toMatch(/complete sentence/);
  });
});
