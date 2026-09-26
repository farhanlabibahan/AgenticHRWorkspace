import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { hasDb } from './setup';
import { candidate, createOrg, day } from './fixtures';
import { db } from '@/lib/db';
import { decodeCursor, encodeCursor } from '@/lib/list-cursor';
import {
  PAGE_SIZE,
  pipelineCounts,
  pipelineHasAny,
  pipelinePage,
  type PipelineFilter,
  type PipelineSort,
} from '@/server/lists/pipeline';
import { contactsPage, contactsTotal, poolCounts, resolvePool } from '@/server/lists/contacts';

/**
 * Keyset pagination, checked against ground truth: every walk (any filter,
 * either sort, any page size) must return exactly the ids of one unpaged
 * ORDER BY query over the old Prisma filter — no duplicates, no gaps — and
 * the tile counts must equal the walks.
 */

type Input = { posting?: string; client?: string; stage?: string; q?: string; status?: string };

/** The pipeline filter as the old Prisma loader wrote it — the semantics keyset must keep. */
function legacyWhere(orgId: string, input: Input): Prisma.OpportunityWhereInput {
  const q = input.q?.trim();
  const has = (s: string) => ({ contains: s, mode: 'insensitive' as const });
  return {
    orgId,
    ...(input.status === 'archived'
      ? { status: 'ARCHIVED' as const }
      : {
          status: { in: ['ACTIVE', 'HIRED'] as const },
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }],
        }),
    ...(input.posting ? { postingId: input.posting } : {}),
    ...(input.client ? { posting: { clientCompanyId: input.client } } : {}),
    ...(input.stage ? { stageId: input.stage } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { contact: { name: has(q) } },
                { contact: { headline: has(q) } },
                { contact: { location: has(q) } },
                { posting: { title: has(q) } },
                { posting: { clientCompany: { name: has(q) } } },
              ],
            },
          ],
        }
      : {}),
  };
}

async function truth(orgId: string, input: Input, sort: PipelineSort = 'time') {
  const rows = await db.opportunity.findMany({
    where: legacyWhere(orgId, input),
    orderBy:
      sort === 'name'
        ? [{ contact: { name: 'asc' } }, { contactId: 'asc' }, { id: 'asc' }]
        : [{ stageChangedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** The PipelineFilter the loader builds for these params (client → its postings). */
async function filterFor(orgId: string, input: Input): Promise<PipelineFilter> {
  let postingIds: string[] | null = null;
  if (input.client) {
    const ps = await db.posting.findMany({ where: { orgId, clientCompanyId: input.client }, select: { id: true } });
    postingIds = ps.map((p) => p.id);
  }
  if (input.posting) postingIds = postingIds ? postingIds.filter((id) => id === input.posting) : [input.posting];
  return {
    orgId,
    view: input.status === 'archived' ? 'archived' : 'active',
    stageId: input.stage,
    postingIds,
    q: input.q,
  };
}

/**
 * Every page, following endCursor; asserts page shape on the way. By name,
 * `nameSmall` picks the strategy: 0 always walks the name index, a big
 * number always sorts the tile (the fixture's tiles are all small).
 */
async function walk(
  f: PipelineFilter,
  sort: PipelineSort = 'time',
  limit = PAGE_SIZE,
  from: string | null = null,
  nameSmall?: number,
) {
  const ids: string[] = [];
  let after = from;
  for (let guard = 0; guard < 2_000; guard++) {
    const page = await pipelinePage(f, sort, { after: after ? decodeCursor(after, sort) : null, limit, nameSmall });
    expect(page.rows.length).toBeLessThanOrEqual(limit);
    ids.push(...page.rows.map((r) => r.id));
    if (!page.hasMore) {
      expect(page.endCursor).toBeNull();
      return ids;
    }
    expect(page.rows.length).toBe(limit);
    after = page.endCursor;
  }
  throw new Error('walk did not end');
}

async function walkContacts(orgId: string, input: { q?: string; tag?: string; pool?: string }, limit = PAGE_SIZE, from: string | null = null) {
  const ids: string[] = [];
  let after = from;
  for (let guard = 0; guard < 2_000; guard++) {
    const page = await contactsPage(orgId, input, { after: after ? decodeCursor(after, 'created') : null, limit });
    ids.push(...page.rows.map((r) => r.id));
    if (!page.hasMore) return ids;
    after = page.endCursor;
  }
  throw new Error('walk did not end');
}

const dup = (ids: string[]) => ids.length - new Set(ids).size;

describe.skipIf(!hasDb)('pipeline keyset pages', () => {
  let orgId = '';
  let otherOrgId = '';
  let stages: { id: string }[] = [];
  let postingA = '';
  let postingB = '';
  let clientX = '';
  const inputs: Input[] = [];

  beforeAll(async () => {
    const org = await createOrg();
    orgId = org.org.id;
    stages = org.stages;
    const client = await db.clientCompany.create({ data: { orgId, name: 'Northbeam' } });
    clientX = client.id;
    const mk = (title: string, clientCompanyId: string | null) =>
      db.posting.create({ data: { orgId, title, slug: `${title.toLowerCase().replace(/\W+/g, '-')}-${orgId.slice(0, 6)}`, clientCompanyId } });
    postingA = (await mk('Staff Designer', clientX)).id;
    postingB = (await mk('Backend Engineer', null)).id;

    // 230 applicants over 7 stageChangedAt values, so every page boundary
    // falls inside a tie group and only the id tiebreak orders them.
    for (let i = 0; i < 230; i++) {
      await candidate(orgId, stages, [[0, i % 7]], {
        name: `Cand ${String(i).padStart(3, '0')}`,
        headline: i % 3 === 0 ? 'Product Designer at Acme' : 'Engineer',
        tags: i % 10 === 0 ? ['visa'] : [],
        postingId: i % 4 === 0 ? postingA : i % 4 === 1 ? postingB : undefined,
      });
    }
    for (let i = 0; i < 12; i++) await candidate(orgId, stages, [[0, 0], [1, 1]], { name: `Screened ${i}` });
    for (let i = 0; i < 5; i++) await candidate(orgId, stages, [[0, 0], [2, 3]], { name: `Onsite ${i}`, status: 'ARCHIVED' });
    await candidate(orgId, stages, [[0, 0]], { name: 'Gone', status: 'ARCHIVED' });
    // HIRED status in a stage that isn't the hired stage still shows in Active.
    await candidate(orgId, stages, [[0, 0], [1, 2]], { name: 'Hired early', status: 'HIRED' });
    await candidate(orgId, stages, [[0, 0], [3, 4]], { name: 'Hired', status: 'HIRED' });
    const future = await candidate(orgId, stages, [[0, 0]], { name: 'Snoozed' });
    await db.opportunity.update({ where: { id: future.opportunity.id }, data: { snoozedUntil: new Date(Date.now() + 86_400_000) } });
    const past = await candidate(orgId, stages, [[0, 0]], { name: 'Woke up' });
    await db.opportunity.update({ where: { id: past.opportunity.id }, data: { snoozedUntil: new Date(Date.now() - 86_400_000) } });
    // Search wildcards must match literally.
    await candidate(orgId, stages, [[0, 2]], { name: '100% Real_Name \\ Backslash' });

    const other = await createOrg();
    otherOrgId = other.org.id;
    await candidate(otherOrgId, other.stages, [[0, 0]], { name: 'Cand 000 (other org)' });
    await candidate(otherOrgId, other.stages, [[0, 3]], { name: 'Aaron Other' });

    inputs.push(
      {},
      ...stages.map((s) => ({ stage: s.id })),
      { status: 'archived' },
      { status: 'archived', stage: stages[2].id },
      { posting: postingA },
      { posting: postingB, stage: stages[0].id },
      { client: clientX },
      { client: clientX, posting: postingB },
      { q: 'cand 01' },
      { q: 'designer' },
      { q: 'northbeam' },
      { q: 'designer', stage: stages[0].id },
    );
  });

  it('walks every filter, both sorts, to exactly the unpaged ids', async () => {
    for (const input of inputs) {
      const f = await filterFor(orgId, input);
      for (const sort of ['time', 'name'] as const) {
        const expected = await truth(orgId, input, sort);
        const walked = await walk(f, sort);
        expect(walked, `${sort} ${JSON.stringify(input)}`).toEqual(expected);
        // Small pages put many more boundaries inside tie groups.
        expect(await walk(f, sort, 7), `${sort} ${JSON.stringify(input)} by 7`).toEqual(expected);
      }
      // Both ways of paging by name: walking the name index, and sorting the tile.
      const byName = await truth(orgId, input, 'name');
      for (const nameSmall of [0, 1_000_000]) {
        expect(await walk(f, 'name', 7, null, nameSmall), `name small=${nameSmall} ${JSON.stringify(input)}`).toEqual(byName);
      }
    }
  });

  it('keeps the old filter semantics: archived, snoozed and HIRED', async () => {
    const f = await filterFor(orgId, {});
    const names = (await walk(f)).length;
    expect(names).toBe(230 + 12 + 2 + 1 + 1); // + two hired, "woke up", the wildcard name
    const rows = (await pipelinePage(f, 'time', { limit: 100 })).rows;
    expect(rows.map((r) => r.name)).not.toContain('Gone');
    const all = await Promise.all((await walk(f)).map((id) => db.opportunity.findUnique({ where: { id }, include: { contact: true } })));
    const allNames = all.map((o) => o!.contact.name);
    expect(allNames).not.toContain('Snoozed');
    expect(allNames).toEqual(expect.arrayContaining(['Woke up', 'Hired early', 'Hired']));
    // oldest time in stage first
    const days = rows.map((r) => r.days);
    expect([...days].sort((a, b) => b - a)).toEqual(days);
  });

  it('matches search wildcards literally', async () => {
    // Prisma's `contains` passed % and _ through as wildcards ("100%" also
    // matched "Cand 100"); the list search takes them literally.
    const [wild] = await truth(orgId, { q: 'Backslash' });
    for (const q of ['100%', 'Real_Name', '\\ Back', '%', '_', '0% R']) {
      for (const sort of ['time', 'name'] as const) {
        expect(await walk(await filterFor(orgId, { q }), sort), q).toEqual([wild]);
      }
    }
    expect(await walk(await filterFor(orgId, { q: 'x%y' }))).toEqual([]);
    expect(await walk(await filterFor(orgId, { q: 'Cand_1' }))).toEqual([]);
  });

  it('counts each tile exactly as its walk, index-only filters included', async () => {
    for (const input of inputs.filter((i) => !i.stage)) {
      const f = await filterFor(orgId, input);
      const counts = await pipelineCounts(f);
      expect(counts.capped).toBe(false);
      expect(counts.total, JSON.stringify(input)).toBe((await walk(f)).length);
      for (const s of stages) {
        expect(counts.counts[s.id] ?? 0, `${s.id} ${JSON.stringify(input)}`).toBe((await walk({ ...f, stageId: s.id })).length);
      }
    }
  });

  it('caps search counts and withholds per-stage numbers past the cap', async () => {
    const f = await filterFor(orgId, { q: 'cand' });
    const capped = await pipelineCounts(f, { cap: 50 });
    expect(capped).toEqual({ counts: {}, total: 50, capped: true });
    const exact = await pipelineCounts(f, { cap: 1_000 });
    expect(exact.capped).toBe(false);
    expect(exact.total).toBe((await walk(f)).length);
    // Without a search the counts are exact, however many there are.
    const all = await pipelineCounts(await filterFor(orgId, {}), { cap: 50 });
    expect(all.capped).toBe(false);
    expect(all.total).toBe((await walk(await filterFor(orgId, {}))).length);
  });

  it('says whether anything is in scope, ignoring search', async () => {
    expect(await pipelineHasAny(await filterFor(orgId, { q: 'no such person' }))).toBe(true);
    expect(await pipelineHasAny({ orgId, view: 'active', postingIds: [] })).toBe(false);
    const empty = await createOrg();
    expect(await pipelineHasAny({ orgId: empty.org.id, view: 'active' })).toBe(false);
  });

  it('never crosses tenants, even with a cursor from another org', async () => {
    const f = await filterFor(orgId, { q: 'cand 000' });
    expect((await walk(f)).length).toBe(1);
    const foreign = await db.opportunity.findFirstOrThrow({ where: { orgId: otherOrgId }, include: { contact: true } });
    const t = foreign.stageChangedAt.toISOString().slice(0, 23);
    const time = encodeCursor({ v: 1, s: 'time', t, id: foreign.id });
    const name = encodeCursor({ v: 1, s: 'name', n: foreign.contact.name, c: foreign.contactId, id: foreign.id });
    const mine = new Set(await truth(orgId, {}));
    for (const [sort, cursor, nameSmall] of [['time', time, undefined], ['name', name, undefined], ['name', name, 0]] as const) {
      const ids = await walk(await filterFor(orgId, {}), sort, PAGE_SIZE, cursor, nameSmall);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => mine.has(id))).toBe(true);
    }
  });

  it('clamps the page size', async () => {
    const f = await filterFor(orgId, {});
    expect((await pipelinePage(f, 'time', { limit: 5_000 })).rows).toHaveLength(PAGE_SIZE);
    expect((await pipelinePage(f, 'time', { limit: 0 })).rows).toHaveLength(PAGE_SIZE);
    expect((await pipelinePage(f, 'time', { limit: -3 })).rows).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)('pipeline keyset ties', () => {
  it('orders ACTIVE and HIRED rows at one timestamp by id across a page boundary', async () => {
    const { org, stages } = await createOrg();
    for (let i = 0; i < 6; i++) {
      await candidate(org.id, stages, [[0, 0], [1, 5]], { name: `A${i}`, status: 'ACTIVE' });
      await candidate(org.id, stages, [[0, 0], [3, 5]], { name: `H${i}`, status: 'HIRED' });
    }
    const f: PipelineFilter = { orgId: org.id, view: 'active' };
    const expected = await truth(org.id, {});
    for (const limit of [1, 3, 5, 7, 12]) expect(await walk(f, 'time', limit)).toEqual(expected);
  });

  it('orders a name shared by 30 people by contact, then opportunity', async () => {
    const { org, stages } = await createOrg();
    for (let i = 0; i < 29; i++) await candidate(org.id, stages, [[0, i % 3]], { name: 'Alex Kim' });
    const many = await candidate(org.id, stages, [[0, 1]], { name: 'Alex Kim' });
    for (let i = 0; i < 2; i++) {
      await db.opportunity.create({
        data: { orgId: org.id, contactId: many.contact.id, stageId: stages[0].id, stageChangedAt: day(1) },
      });
    }
    await candidate(org.id, stages, [[0, 0]], { name: 'Aaron First' });
    await candidate(org.id, stages, [[0, 0]], { name: 'Zed Last' });
    const f: PipelineFilter = { orgId: org.id, view: 'active' };
    const expected = await truth(org.id, {}, 'name');
    expect(expected).toHaveLength(34);
    for (const limit of [1, 2, 4, 5, 9, 100]) {
      for (const nameSmall of [undefined, 0]) {
        const walked = await walk(f, 'name', limit, null, nameSmall);
        expect(walked).toEqual(expected);
        expect(dup(walked)).toBe(0);
      }
    }
    const stageOnly = await walk({ ...f, stageId: stages[0].id }, 'name', 4);
    expect(stageOnly).toEqual(await truth(org.id, { stage: stages[0].id }, 'name'));
  });
});

describe.skipIf(!hasDb)('pipeline keyset under concurrent edits', () => {
  /** 300 active candidates in the first stage, ten to a timestamp. */
  async function seed() {
    const { org, stages } = await createOrg();
    for (let i = 0; i < 300; i++) await candidate(org.id, stages, [[0, i % 10]], { name: `P${i}` });
    return { orgId: org.id, stages };
  }

  const at = (t: string) => new Date(`${t}Z`);

  for (const view of ['all', 'stage'] as const) {
    it(`sees every row that matched throughout exactly once (${view})`, async () => {
      const { orgId, stages } = await seed();
      const f: PipelineFilter = { orgId, view: 'active', stageId: view === 'stage' ? stages[0].id : undefined };
      const before = await truth(orgId, { stage: f.stageId });
      const first = await pipelinePage(f, 'time', { limit: 100 });
      expect(first.rows.map((r) => r.id)).toEqual(before.slice(0, 100));
      const cursor = decodeCursor(first.endCursor, 'time')!;

      const mkOpp = async (stageChangedAt: Date, id?: string) => {
        const c = await db.contact.create({ data: { orgId, name: 'Inserted' } });
        return (
          await db.opportunity.create({ data: { id, orgId, contactId: c.id, stageId: stages[0].id, stageChangedAt } })
        ).id;
      };
      const older = [await mkOpp(day(-5)), await mkOpp(day(-5)), await mkOpp(day(-4))];
      const newer = [await mkOpp(day(50)), await mkOpp(day(51)), await mkOpp(day(52))];
      // Exactly at the cursor: a proper prefix of its id sorts before it, a suffix after.
      const tieBefore = await mkOpp(at(cursor.t), cursor.id.slice(0, -1));
      const tieAfter = await mkOpp(at(cursor.t), `${cursor.id}z`);
      const archived = [before[120], before[150]];
      await db.opportunity.updateMany({ where: { id: { in: archived } }, data: { status: 'ARCHIVED' } });
      const moved = before[230];
      await db.opportunity.update({ where: { id: moved }, data: { stageId: stages[1].id, stageChangedAt: day(60) } });
      const snoozed = before[250];
      await db.opportunity.update({ where: { id: snoozed }, data: { snoozedUntil: new Date(Date.now() + 3_600_000) } });

      const rest = await walk(f, 'time', 100, first.endCursor);
      const all = [...first.rows.map((r) => r.id), ...rest];
      expect(dup(all)).toBe(0);
      const gone = new Set([...archived, snoozed, ...(view === 'stage' ? [moved] : [])]);
      for (const id of before) expect(all.includes(id), id).toBe(!gone.has(id) || (view === 'all' && id === moved));
      for (const id of older) expect(all).not.toContain(id); // behind the cursor, by design
      expect(all).not.toContain(tieBefore);
      expect(all.filter((id) => id === tieAfter)).toHaveLength(1);
      const tail = view === 'all' ? [...newer, moved] : newer;
      expect(all.slice(-tail.length)).toEqual(tail);
    });
  }

  it('OFFSET paging would have skipped rows that keyset keeps', async () => {
    const { orgId } = await seed();
    const f: PipelineFilter = { orgId, view: 'active' };
    const before = await truth(orgId, {});
    const first = await pipelinePage(f, 'time', { limit: 100 });
    await db.opportunity.updateMany({ where: { id: { in: [before[3], before[4]] } }, data: { status: 'ARCHIVED' } });
    const offsetPage2 = await db.opportunity.findMany({
      where: legacyWhere(orgId, {}),
      orderBy: [{ stageChangedAt: 'asc' }, { id: 'asc' }],
      skip: 100,
      take: 100,
      select: { id: true },
    });
    expect(offsetPage2.map((r) => r.id)).not.toContain(before[100]); // skipped
    const keysetPage2 = await pipelinePage(f, 'time', { after: decodeCursor(first.endCursor, 'time'), limit: 100 });
    expect(keysetPage2.rows[0].id).toBe(before[100]);
  });
});

describe.skipIf(!hasDb)('time zones', () => {
  const url = process.env.TEST_DATABASE_URL ?? '';
  const dbName = url ? new URL(url).pathname.slice(1) : '';
  const originalTz = process.env.TZ;

  afterAll(async () => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    await db.$executeRawUnsafe(`ALTER DATABASE "${dbName}" RESET timezone`);
    await db.$disconnect();
  });

  it('pages identically whatever the process and session time zones', async () => {
    const { org, stages } = await createOrg();
    for (let i = 0; i < 60; i++) {
      const { opportunity } = await candidate(org.id, stages, [[0, i % 4]], { name: `T${i}` });
      // Times of day near midnight, so a shifted comparison would move rows across days.
      await db.opportunity.update({
        where: { id: opportunity.id },
        data: { stageChangedAt: new Date(day(i % 4).getTime() + (i % 2 ? 23.5 : 0.25) * 3_600_000) },
      });
    }
    const soon = await candidate(org.id, stages, [[0, 0]], { name: 'Wakes in a minute' });
    await db.opportunity.update({ where: { id: soon.opportunity.id }, data: { snoozedUntil: new Date(Date.now() + 60_000) } });
    const just = await candidate(org.id, stages, [[0, 0]], { name: 'Woke a minute ago' });
    await db.opportunity.update({ where: { id: just.opportunity.id }, data: { snoozedUntil: new Date(Date.now() - 60_000) } });

    const f: PipelineFilter = { orgId: org.id, view: 'active' };
    const baseline = await walk(f, 'time', 7);
    const contacts = await walkContacts(org.id, {}, 7);
    expect(baseline).toContain(just.opportunity.id);
    expect(baseline).not.toContain(soon.opportunity.id);

    process.env.TZ = 'America/Los_Angeles';
    await db.$executeRawUnsafe(`ALTER DATABASE "${dbName}" SET timezone TO 'Pacific/Auckland'`);
    await db.$disconnect(); // new connections pick up the database default
    const [{ tz }] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tz).toBe('Pacific/Auckland');
    expect(new Date(0).getTimezoneOffset()).not.toBe(0);

    expect(await walk(f, 'time', 7)).toEqual(baseline);
    expect(await walkContacts(org.id, {}, 7)).toEqual(contacts);
  });
});

describe.skipIf(!hasDb)('contacts keyset pages', () => {
  let orgId = '';

  beforeAll(async () => {
    const { org, stages } = await createOrg();
    orgId = org.id;
    // One createMany: 40 contacts under one createdAt, like a CSV import.
    await db.contact.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        orgId,
        name: `Imported ${i}`,
        tags: i % 4 === 0 ? ['referral'] : [],
        headline: i % 5 === 0 ? 'Designer' : null,
      })),
    });
    for (let i = 0; i < 30; i++) await candidate(orgId, stages, [[0, i % 3]], { name: `Cand ${i}`, tags: i % 2 ? ['visa'] : [] });
  });

  async function contactsTruth(where: Prisma.ContactWhereInput) {
    const rows = await db.contact.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    return rows.map((r) => r.id);
  }

  it('walks newest first to exactly the unpaged ids, ties included', async () => {
    for (const limit of [1, 7, 100]) {
      expect(await walkContacts(orgId, {}, limit)).toEqual(await contactsTruth({ orgId }));
      expect(await walkContacts(orgId, { tag: 'referral' }, limit)).toEqual(
        await contactsTruth({ orgId, tags: { has: 'referral' } }),
      );
      expect(await walkContacts(orgId, { q: 'designer' }, limit)).toEqual(
        await contactsTruth({ orgId, OR: [{ name: { contains: 'designer', mode: 'insensitive' } }, { headline: { contains: 'designer', mode: 'insensitive' } }] }),
      );
    }
  });

  it('does not repeat or drop rows when contacts are added or deleted between pages', async () => {
    const { org } = await createOrg();
    await db.contact.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ orgId: org.id, name: `C${i}`, createdAt: day(i % 3) })) });
    const before = await contactsTruth({ orgId: org.id });
    const first = await contactsPage(org.id, {}, { limit: 10 });
    await db.contact.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ orgId: org.id, name: `New ${i}` })) });
    const deleted = [before[12], before[15]];
    await db.contact.deleteMany({ where: { id: { in: deleted } } });
    const rest = await walkContacts(org.id, {}, 10, first.endCursor);
    const all = [...first.rows.map((r) => r.id), ...rest];
    expect(dup(all)).toBe(0);
    expect(all).toEqual(before.filter((id) => !deleted.includes(id)));
  });

  it('pages a static pool, a dynamic segment, and counts them', async () => {
    const members = await contactsTruth({ orgId });
    const pool = await db.talentPool.create({
      data: { orgId, name: 'Shortlist', kind: 'STATIC', members: { connect: members.slice(0, 33).map((id) => ({ id })) } },
    });
    const segment = await db.talentPool.create({ data: { orgId, name: 'Visa', kind: 'DYNAMIC', rules: { tag: 'visa' } } });
    const walked = await walkContacts(orgId, { pool: pool.id }, 7);
    expect(walked).toEqual(members.slice(0, 33));
    expect(await walkContacts(orgId, { pool: segment.id }, 4)).toEqual(await contactsTruth({ orgId, tags: { has: 'visa' } }));

    const pools = await db.talentPool.findMany({ where: { orgId }, select: { id: true, kind: true, rules: true } });
    const counts = await poolCounts(orgId, pools);
    expect(counts[pool.id]).toEqual({ count: 33, capped: false });
    expect(counts[segment.id]).toEqual({ count: 15, capped: false });
    expect((await poolCounts(orgId, pools, 10))[segment.id]).toEqual({ count: 10, capped: true });

    expect(await contactsTotal(orgId, {}, null)).toEqual({ count: 70, capped: false });
    expect(await contactsTotal(orgId, {}, await resolvePool(orgId, pool.id))).toEqual({ count: 33, capped: false });
    expect(await contactsTotal(orgId, { tag: 'referral' }, null)).toEqual({ count: 10, capped: false });
    expect(await contactsTotal(orgId, { tag: 'referral' }, null, 5)).toEqual({ count: 5, capped: true });
  });

  it('only ever returns the caller’s contacts', async () => {
    const other = await createOrg();
    const foreign = await db.contact.create({ data: { orgId: other.org.id, name: 'Imported 1 (other org)' } });
    const cursor = encodeCursor({ v: 1, s: 'created', t: foreign.createdAt.toISOString(), id: foreign.id });
    const mine = new Set(await contactsTruth({ orgId }));
    const ids = await walkContacts(orgId, { q: 'Imported 1' }, 100, cursor);
    expect(ids.every((id) => mine.has(id))).toBe(true);
    expect(await walkContacts(orgId, { q: 'other org' })).toEqual([]);
  });
});
