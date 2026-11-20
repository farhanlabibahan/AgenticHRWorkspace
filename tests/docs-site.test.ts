import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/server/ai-client', () => ({ aiConfigured: () => false }));

import { defaultContent, isPublished, readContent, readTeam } from '@/lib/docs-site';

describe('public documentation', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');

  it('stays unavailable while disabled, regardless of schedule', () => {
    expect(isPublished({ enabled: false, startsAt: null, endsAt: null }, now)).toBe(false);
  });

  it('is available only inside its publication window', () => {
    const site = { enabled: true, startsAt: new Date('2026-11-20T10:00:00Z'), endsAt: new Date('2026-11-20T14:00:00Z') };
    expect(isPublished(site, new Date('2026-11-20T09:59:59Z'))).toBe(false);
    expect(isPublished(site, now)).toBe(true);
    expect(isPublished(site, site.endsAt)).toBe(false);
    expect(isPublished({ enabled: true, startsAt: null, endsAt: null }, now)).toBe(true);
  });

  it('restores missing editable sections and rejects malformed team rows', () => {
    expect(readContent({ headline: 'A custom headline' })).toEqual({ ...defaultContent, headline: 'A custom headline' });
    expect(readTeam([{ name: 'No id' }, null])).toEqual([]);
  });
});
