import { beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { db } from '@/lib/db';
import {
  avgDaysToHire,
  interviewerLoad,
  recruiterProductivity,
  reportBuilderCounts,
  stagePassThrough,
  stagePassThroughBy,
  timeInStage,
  velocityByPosting,
} from '@/server/analytics';

/**
 * Four candidates through Applied → Screen → On-site → Hired, small enough to
 * work out every number by hand:
 *   A  Applied d0 → Screen d2 → On-site d5 → Hired d9   HIRED   posting "Designer", owner Uma
 *   B  Applied d0 → Screen d4                           ACTIVE  posting "Designer", owner Uma
 *   C  Applied d0                                       ARCHIVED               owner Uma
 *   D  Applied d1 → On-site d3 (skips Screen)            ACTIVE  unowned, no posting
 */
describe.skipIf(!hasDb)('analytics', () => {
  let orgId = '';
  let uma = '';
  let vic = '';

  beforeAll(async () => {
    const { org, stages } = await createOrg();
    orgId = org.id;
    uma = (await db.user.create({ data: { orgId, email: 'uma@test.local', name: 'Uma' } })).id;
    vic = (await db.user.create({ data: { orgId, email: 'vic@test.local', name: 'Vic' } })).id;
    const designer = await db.posting.create({ data: { orgId, slug: 'designer', title: 'Designer' } });
    const a = await candidate(orgId, stages, [[0, 0], [1, 2], [2, 5], [3, 9]], {
      status: 'HIRED', postingId: designer.id, ownerId: uma,
    });
    await candidate(orgId, stages, [[0, 0], [1, 4]], { postingId: designer.id, ownerId: uma });
    await candidate(orgId, stages, [[0, 0]], { status: 'ARCHIVED', ownerId: uma });
    await candidate(orgId, stages, [[0, 1], [2, 3]]);

    // Panel on A: both scheduled and completed; only Uma filed a scorecard.
    const done = await db.interview.create({
      data: {
        orgId, opportunityId: a.opportunity.id, title: 'Loop', startAt: new Date(), state: 'COMPLETED',
        panelists: { connect: [{ id: uma }, { id: vic }] },
      },
    });
    await db.feedbackSubmission.create({
      data: { orgId, opportunityId: a.opportunity.id, interviewId: done.id, authorId: uma, overallRating: 4, summary: 'yes' },
    });
    // Canceled interviews never count.
    await db.interview.create({
      data: {
        orgId, opportunityId: a.opportunity.id, title: 'Old', startAt: new Date(), state: 'CANCELED',
        panelists: { connect: [{ id: uma }] },
      },
    });
  });

  it('counts pass-through by furthest stage reached, including skipped stages', async () => {
    expect(await stagePassThrough(orgId)).toEqual([
      { name: 'Applied', reached: 4, conversion: null },
      { name: 'Screen', reached: 3, conversion: 75 },
      { name: 'On-site', reached: 2, conversion: 67 },
      { name: 'Hired', reached: 1, conversion: 50 },
    ]);
  });

  it('groups pass-through by posting, keeping opportunities without one', async () => {
    expect(await stagePassThroughBy(orgId, 'posting')).toEqual({
      stages: ['Applied', 'Screen', 'On-site', 'Hired'],
      rows: [
        { group: 'Designer', reached: [2, 2, 1, 1] },
        { group: 'No posting', reached: [2, 1, 1, 0] },
      ],
    });
  });

  it('averages completed dwell time per stage', async () => {
    // Applied: 2d (A), 4d (B), 2d (D) → 2.7 · Screen: 3d (A) · On-site: 4d (A)
    expect(await timeInStage(orgId)).toEqual([
      { name: 'Applied', samples: 3, avgDays: 2.7 },
      { name: 'Screen', samples: 1, avgDays: 3 },
      { name: 'On-site', samples: 1, avgDays: 4 },
      { name: 'Hired', samples: 0, avgDays: null },
    ]);
  });

  it('reports velocity, recruiter productivity, and days to hire', async () => {
    expect(await velocityByPosting(orgId)).toEqual([
      { posting: 'Designer', active: 1, hired: 1, avgDaysToHire: 9 },
      { posting: 'No posting', active: 1, hired: 0, avgDaysToHire: null },
    ]);
    expect(await recruiterProductivity(orgId)).toEqual([
      { name: 'Uma', active: 1, hired: 1, archived: 1, avgDaysToHire: 9 },
    ]);
    expect(await avgDaysToHire(orgId)).toBe(9);
  });

  it('counts interviewer load and scorecard completion, ignoring canceled interviews', async () => {
    expect(await interviewerLoad(orgId)).toEqual([
      { name: 'Uma', scheduled: 1, completed: 1, feedbacks: 1, feedbackRate: 100, avgRating: 4 },
      { name: 'Vic', scheduled: 1, completed: 1, feedbacks: 0, feedbackRate: 0, avgRating: null },
    ]);
  });

  it('builder counts every matching opportunity, with filters and month buckets', async () => {
    expect(await reportBuilderCounts(orgId, 'stage', {})).toEqual([
      { name: 'Applied', count: 1 },
      { name: 'Hired', count: 1 },
      { name: 'On-site', count: 1 },
      { name: 'Screen', count: 1 },
    ]);
    expect(await reportBuilderCounts(orgId, 'stage', { status: 'HIRED' })).toEqual([{ name: 'Hired', count: 1 }]);
    expect(await reportBuilderCounts(orgId, 'month', {})).toEqual([{ name: '2026-01', count: 4 }]);
    expect(
      await reportBuilderCounts(orgId, 'owner', { from: new Date('2026-01-06T00:00:00Z') }),
    ).toEqual([{ name: 'Unassigned', count: 1 }]);
  });

  it('returns empty results for an org with no data', async () => {
    const { org } = await createOrg();
    expect((await stagePassThrough(org.id)).map((s) => s.reached)).toEqual([0, 0, 0, 0]);
    expect(await velocityByPosting(org.id)).toEqual([]);
    expect(await avgDaysToHire(org.id)).toBeNull();
    expect(await reportBuilderCounts(org.id, 'stage', {})).toEqual([]);
  });
});
