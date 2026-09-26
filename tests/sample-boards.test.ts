import { describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { db } from '@/lib/db';
import { SAMPLE_BOARD_SLUGS, SAMPLE_PRESENTATION_CODE } from '@/lib/sample-links';
import { ensureSampleBoard, ensureSamplePresentation, isSampleSlug } from '@/server/sample-boards';
import { resolveShare } from '@/server/share-links';
import { createWorkspace } from '@/server/workspace';
import { applyAction } from '@/app/careers/actions';

/** The homepage's sample job boards and presentation: seeded once, read-only. */

describe('isSampleSlug', () => {
  it('is only the reserved sample- prefix', () => {
    expect(isSampleSlug(SAMPLE_BOARD_SLUGS.employer)).toBe(true);
    expect(isSampleSlug('samples-inc')).toBe(false);
    expect(isSampleSlug('acme')).toBe(false);
  });
});

describe.skipIf(!hasDb)('sample boards', () => {
  it('seeds each board once, however many first visits race', async () => {
    await Promise.all([ensureSampleBoard(SAMPLE_BOARD_SLUGS.employer), ensureSampleBoard(SAMPLE_BOARD_SLUGS.employer)]);
    await ensureSampleBoard(SAMPLE_BOARD_SLUGS.employer);

    const orgs = await db.organization.findMany({ where: { slug: SAMPLE_BOARD_SLUGS.employer } });
    expect(orgs).toHaveLength(1);
    expect(orgs[0].kind).toBe('COMPANY');
    const postings = await db.posting.findMany({ where: { orgId: orgs[0].id, state: 'PUBLISHED' }, include: { department: true } });
    expect(postings).toHaveLength(5);
    expect(new Set(postings.map((p) => p.department?.name))).toEqual(new Set(['Design', 'Engineering']));
    // Nobody can sign in to it.
    expect(await db.user.count({ where: { orgId: orgs[0].id } })).toBe(0);
  });

  it('groups the agency board by client and serves the sample presentation on its fixed code', async () => {
    await ensureSamplePresentation();
    const org = await db.organization.findUniqueOrThrow({ where: { slug: SAMPLE_BOARD_SLUGS.agency } });
    expect(org.kind).toBe('AGENCY');
    const clients = (await db.clientCompany.findMany({ where: { orgId: org.id } })).map((c) => c.name).sort();
    expect(clients).toEqual(['Meridian Health', 'Relay']);

    const share = await resolveShare(SAMPLE_PRESENTATION_CODE);
    expect(share).toMatchObject({ orgId: org.id, scope: 'candidate' });
    const opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: share!.id }, include: { contact: true, aiEvaluations: true } });
    expect(opportunity.contact.name).toBe('Jordan Alvarez');
    expect(opportunity.aiEvaluations[0].strengths.length).toBeGreaterThan(0);
  });

  it('refuses applications on a sample board', async () => {
    const form = new FormData();
    form.set('orgSlug', SAMPLE_BOARD_SLUGS.employer);
    form.set('postingSlug', 'founding-engineer');
    form.set('name', 'Someone');
    form.set('email', 'someone@example.com');
    const result = await applyAction({}, form);
    expect(result?.error).toMatch(/sample job board/);
  });

  it('never gives a new workspace a sample- slug', async () => {
    const { orgId } = await createWorkspace({
      orgName: 'Sample Northwind',
      name: 'Real Person',
      email: `sample-${Date.now()}@example.com`,
      passwordHash: null,
    });
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.slug).toMatch(/^sample-northwind-[a-z0-9]+$/);
  });
});
