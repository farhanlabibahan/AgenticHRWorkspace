import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { signInErrorMessage } from '@/lib/auth-errors';

describe('safeRedirectPath', () => {
  const origin = 'https://source-ats.vercel.app';

  it('keeps a path on this site, with its query and hash', () => {
    expect(safeRedirectPath('/pipeline?stage=abc#top')).toBe('/pipeline?stage=abc#top');
    expect(safeRedirectPath(`${origin}/candidates/1?x=1`, { origin })).toBe('/candidates/1?x=1');
  });

  it('falls back for anything that could leave the site', () => {
    for (const raw of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'javascript:alert(1)',
      'data:text/html,hi',
      'evil.example',
      '/a/../..//evil.example',
      `${origin}.evil.example/x`,
      'http://source-ats.vercel.app/x', // same host, other scheme
    ]) {
      expect(safeRedirectPath(raw, { origin }), raw).toBe('/dashboard');
    }
  });

  it('refuses absolute URLs when it has no origin to compare with', () => {
    expect(safeRedirectPath(`${origin}/pipeline`)).toBe('/dashboard');
  });

  it('falls back for missing or odd input, to the given fallback', () => {
    expect(safeRedirectPath(undefined)).toBe('/dashboard');
    expect(safeRedirectPath('')).toBe('/dashboard');
    expect(safeRedirectPath(['/x'])).toBe('/dashboard');
    expect(safeRedirectPath('/'.padEnd(3000, 'a'))).toBe('/dashboard');
    expect(safeRedirectPath(null, { fallback: '/onboarding' })).toBe('/onboarding');
  });
});

describe('signInErrorMessage', () => {
  it('explains our codes and never echoes the raw code', () => {
    expect(signInErrorMessage('google-deactivated', { google: true })).toMatch(/deactivated/);
    expect(signInErrorMessage('<script>', { google: true })).toBe('Google sign-in didn’t finish. Please try again.');
    expect(signInErrorMessage(undefined, { google: true })).toBeNull();
  });

  it('never mentions Google where Google sign-in is off', () => {
    expect(signInErrorMessage('AccessDenied', { google: false })).not.toMatch(/google/i);
    expect(signInErrorMessage('google-expired', { google: false })).not.toMatch(/google/i);
  });
});
