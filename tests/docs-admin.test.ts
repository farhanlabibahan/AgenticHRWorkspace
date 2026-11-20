import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

import { issueDocsSession, verifyDocsSession } from '@/lib/docs-admin';

describe('documentation password session', () => {
  const now = Date.parse('2026-11-21T00:00:00Z');
  const secret = 'test-auth-secret:docs:test-password';

  it('accepts a signed session until it expires', () => {
    const token = issueDocsSession(secret, now);
    expect(verifyDocsSession(token, secret, now + 1000)).toBe(true);
    expect(verifyDocsSession(token, secret, now + 4 * 60 * 60 * 1000)).toBe(false);
  });

  it('rejects tampering and secret rotation', () => {
    const token = issueDocsSession(secret, now);
    expect(verifyDocsSession(token, secret + '-rotated', now)).toBe(false);
    expect(verifyDocsSession(token.slice(0, -1) + 'x', secret, now)).toBe(false);
    expect(verifyDocsSession(undefined, secret, now)).toBe(false);
  });
});
