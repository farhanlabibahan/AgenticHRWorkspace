import { describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { db } from '@/lib/db';
import { guessInterviewType, stageGroup } from '@/lib/stage-types';
import { DEFAULT_STAGES } from '@/server/org-defaults';
import { createStage, setStageOrder } from '@/server/stages';

/** The pipeline editor: leads, applicants, then the interview process. */

describe('guessInterviewType', () => {
  it.each([
    ['Phone Screen', 'SCREEN'],
    ['Portfolio Review', 'SCREEN'],
    ['Portfolio Interview', 'ONSITE'],
    ['Present Candidate to Client', 'ONSITE'],
    ['Client Interview', 'ONSITE'],
    ['Reference check (optional)', 'OFFER'],
    ['Offer', 'OFFER'],
    ['Hired', 'HIRED'],
    ['New lead', 'SCREEN'], // a lead word never makes an interview stage a Lead
  ])('%s counts as %s', (name, type) => {
    expect(guessInterviewType(name)).toBe(type);
  });
});

describe('DEFAULT_STAGES', () => {
  it('opens with leads, then applicants, then the interview process ending in Hired', () => {
    const groups = DEFAULT_STAGES.map((s) => stageGroup(s.type));
    expect(groups).toEqual([...groups].sort((a, b) => ['lead', 'applicant', 'interview'].indexOf(a) - ['lead', 'applicant', 'interview'].indexOf(b)));
    expect(DEFAULT_STAGES.map((s) => s.order)).toEqual(DEFAULT_STAGES.map((_, i) => i));
    expect(DEFAULT_STAGES.at(-1)!.type).toBe('HIRED');
  });
});

const names = async (orgId: string) => (await db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } })).map((s) => s.name);

describe.skipIf(!hasDb)('stages', () => {
  async function org() {
    const { org, admin } = await createOrg(['New lead', 'New applicant', 'Phone screen', 'Offer', 'Hired']);
    // createOrg types stages by position; give these their real types.
    const types = { 'New lead': 'LEAD', 'New applicant': 'APPLICANT', 'Phone screen': 'SCREEN', Offer: 'OFFER', Hired: 'HIRED' } as const;
    for (const [name, type] of Object.entries(types)) await db.stage.updateMany({ where: { orgId: org.id, name }, data: { type } });
    return { orgId: org.id, ctx: { userId: admin.id, orgId: org.id, accessRole: 'SUPER_ADMIN' as const } };
  }

  it('adds a stage at the end of its group; in the interview process, just before Hired', async () => {
    const { orgId, ctx } = await org();
    await createStage(ctx, 'Reached out', 'LEAD');
    await createStage(ctx, 'Referred', 'APPLICANT');
    await createStage(ctx, 'Client interview', 'ONSITE');
    await createStage(ctx, 'Reference check', 'OFFER');
    await createStage(ctx, 'Started', 'HIRED');
    expect(await names(orgId)).toEqual([
      'New lead',
      'Reached out',
      'New applicant',
      'Referred',
      'Phone screen',
      'Offer',
      'Client interview',
      'Reference check',
      'Hired',
      'Started',
    ]);
    await expect(createStage(ctx, 'phone Screen', 'SCREEN')).rejects.toThrow(/already a stage/);
  });

  it('saves a dragged order, keeping leads before applicants before the interview process', async () => {
    const { orgId, ctx } = await org();
    const byName = new Map((await db.stage.findMany({ where: { orgId } })).map((s) => [s.name, s.id]));
    const id = (n: string) => byName.get(n)!;

    // Offer dragged above Phone screen, and a lead dropped among the interview stages.
    await setStageOrder(ctx, ['New applicant', 'Offer', 'Phone screen', 'New lead', 'Hired'].map(id));
    expect(await names(orgId)).toEqual(['New lead', 'New applicant', 'Offer', 'Phone screen', 'Hired']);

    await expect(setStageOrder(ctx, ['New lead', 'Hired'].map(id))).rejects.toThrow(/changed while you were editing/);
    await expect(setStageOrder(ctx, ['New lead', 'New lead', 'Offer', 'Phone screen', 'Hired'].map(id))).rejects.toThrow();
  });
});
