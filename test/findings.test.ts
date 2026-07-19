import { describe, it, expect } from 'vitest';
import { mutedKeys } from '../src/rules';
import { remediationFor, findingTransitionError } from '../src/actions';

// --- mutedKeys: the dismiss "mute until restored" rule, keyed (path, rule) -----
describe('mutedKeys', () => {
  it('mutes a key whose only/latest row is dismissed', () => {
    const m = mutedKeys([{ id: 1, path: '/a', rule: 'missing_og_image', status: 'dismissed' }]);
    expect([...m]).toEqual(['/a missing_og_image']); // "path rule", matching runRules keyOf
  });

  it('does not mute open or resolved keys', () => {
    const m = mutedKeys([
      { id: 1, path: '/a', rule: 'r1', status: 'open' },
      { id: 2, path: '/b', rule: 'r2', status: 'resolved' },
    ]);
    expect(m.size).toBe(0);
  });

  it('the MOST RECENT row wins — a later resolved row (a restore) un-mutes', () => {
    const m = mutedKeys([
      { id: 5, path: '/a', rule: 'r', status: 'dismissed' },
      { id: 9, path: '/a', rule: 'r', status: 'resolved' },
    ]);
    expect(m.has('/a r')).toBe(false);
  });

  it('a later dismissed row re-mutes after an earlier open/resolved', () => {
    const m = mutedKeys([
      { id: 3, path: '/a', rule: 'r', status: 'resolved' },
      { id: 7, path: '/a', rule: 'r', status: 'dismissed' },
    ]);
    expect(m.has('/a r')).toBe(true);
  });

  it('collapses a full multi-row history to the latest row per key', () => {
    const m = mutedKeys([
      { id: 1, path: '/a', rule: 'r', status: 'open' },
      { id: 2, path: '/a', rule: 'r', status: 'resolved' },
      { id: 8, path: '/a', rule: 'r', status: 'dismissed' }, // latest for /a → muted
      { id: 4, path: '/b', rule: 'r', status: 'dismissed' },
      { id: 6, path: '/b', rule: 'r', status: 'open' }, // latest for /b → not muted
    ]);
    expect(m.has('/a r')).toBe(true);
    expect(m.has('/b r')).toBe(false);
  });

  it('is order-insensitive (max id wins regardless of input order)', () => {
    const rows = [
      { id: 8, path: '/a', rule: 'r', status: 'dismissed' },
      { id: 2, path: '/a', rule: 'r', status: 'resolved' },
    ];
    expect(mutedKeys(rows).has('/a r')).toBe(true);
    expect(mutedKeys([...rows].reverse()).has('/a r')).toBe(true);
  });

  it('is empty for no rows', () => {
    expect(mutedKeys([]).size).toBe(0);
  });
});

// --- remediationFor: a finding's latest proposal → remediation state ----------
describe('remediationFor', () => {
  it('null when there is no linked proposal', () => {
    expect(remediationFor(undefined)).toBeNull();
    expect(remediationFor(null)).toBeNull();
  });

  it('proposed → proposal_pending, carrying the proposal id', () => {
    expect(remediationFor({ id: 12, status: 'proposed' })).toEqual({ state: 'proposal_pending', proposalId: 12 });
  });

  it('approved → applied_awaiting_recrawl (an approved proposal always has a live change)', () => {
    expect(remediationFor({ id: 3, status: 'approved' })).toEqual({ state: 'applied_awaiting_recrawl', proposalId: 3 });
  });

  it('rejected → proposal_rejected', () => {
    expect(remediationFor({ id: 4, status: 'rejected' })).toEqual({ state: 'proposal_rejected', proposalId: 4 });
  });

  it('reverted (or any other status) → null — no active remediation', () => {
    expect(remediationFor({ id: 5, status: 'reverted' })).toBeNull();
    expect(remediationFor({ id: 6, status: 'something-new' })).toBeNull();
  });
});

// --- findingTransitionError: the 404 / 409 contract for dismiss & restore -----
describe('findingTransitionError', () => {
  it('404 when the finding does not exist', () => {
    expect(findingTransitionError(null, 'dismiss')).toEqual({ status: 404, message: 'finding not found' });
    expect(findingTransitionError(undefined, 'restore')?.status).toBe(404);
  });

  it('dismiss is allowed only from open', () => {
    expect(findingTransitionError({ status: 'open' }, 'dismiss')).toBeNull();
    expect(findingTransitionError({ status: 'dismissed' }, 'dismiss')?.status).toBe(409);
    expect(findingTransitionError({ status: 'resolved' }, 'dismiss')?.status).toBe(409);
  });

  it('restore is allowed only from dismissed', () => {
    expect(findingTransitionError({ status: 'dismissed' }, 'restore')).toBeNull();
    expect(findingTransitionError({ status: 'open' }, 'restore')?.status).toBe(409);
    expect(findingTransitionError({ status: 'resolved' }, 'restore')?.status).toBe(409);
  });

  it('the 409 message names the current status and the intended action', () => {
    const e = findingTransitionError({ status: 'resolved' }, 'dismiss');
    expect(e?.message).toContain('resolved');
    expect(e?.message).toContain('dismissed');
  });
});
