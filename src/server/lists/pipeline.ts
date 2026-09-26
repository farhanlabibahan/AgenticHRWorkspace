import { Prisma, type OpportunityStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { encodeCursor, type NameCursor, type TimeCursor } from '@/lib/list-cursor';
import type { ListPage, PipelineRow, StageCounts } from '@/lib/list-types';
import type { ListMeta } from '@/server/list-meta';

/**
 * The pipeline list in SQL: one WHERE builder shared by the rows (both sort
 * orders) and the tile counts, so a tile and the rows under it can never
 * disagree, and keyset pages instead of OFFSET, so page 50 costs what page 1
 * does.
 *
 * Table aliases, everywhere: o = Opportunity, c = Contact, po = Posting,
 * cc = ClientCompany.
 */

export type PipelineView = 'active' | 'archived';
export type PipelineSort = 'time' | 'name';

export type PipelineFilter = {
  orgId: string;
  view: PipelineView;
  stageId?: string;
  /**
   * The postings in scope: ?posting, or every posting of ?client. null means
   * any posting (including none); an empty list means nothing can match.
   */
  postingIds?: string[] | null;
  q?: string;
};

/** The pipeline's URL params, already whitelisted to strings. */
export type PipelineParams = {
  posting?: string;
  client?: string;
  stage?: string;
  q?: string;
  status?: string;
  sort?: string;
};

/**
 * The list filter for a set of params. ?client narrows to that client's
 * postings (from the cached meta, so the query needs no join), and a
 * ?posting outside the client matches nothing, as before.
 */
export function pipelineFilterFor(
  orgId: string,
  input: PipelineParams,
  meta: Pick<ListMeta, 'postings'> | null,
): PipelineFilter {
  let postingIds: string[] | null = null;
  if (input.client) {
    postingIds = (meta?.postings ?? []).filter((p) => p.clientCompanyId === input.client).map((p) => p.id);
  }
  if (input.posting) postingIds = postingIds ? postingIds.filter((id) => id === input.posting) : [input.posting];
  return {
    orgId,
    view: input.status === 'archived' ? 'archived' : 'active',
    stageId: input.stage || undefined,
    postingIds,
    q: input.q?.trim() || undefined,
  };
}

/** Rows per page, and the most a caller may ask for. */
export const PAGE_SIZE = 100;
/** Searches count up to this many matches, then say "10,000+". */
export const COUNT_CAP = 10_000;

const VIEW_STATUSES: Record<PipelineView, OpportunityStatus[]> = {
  active: ['ACTIVE', 'HIRED'],
  archived: ['ARCHIVED'],
};

/** Literal SQL for a whitelisted enum value or integer — never user text. */
const statusSql = (s: OpportunityStatus) => Prisma.raw(`'${s}'::"OpportunityStatus"`);
const intSql = (n: number) => Prisma.raw(String(Math.trunc(n)));

/** `%needle%` for ILIKE ... ESCAPE '\', with the needle's own wildcards taken literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const searchText = (f: PipelineFilter) => f.q?.trim() ?? '';

/** The joins search needs, for queries that don't already join them. */
function searchJoins(f: PipelineFilter): Prisma.Sql {
  if (!searchText(f)) return Prisma.empty;
  return Prisma.sql`
    JOIN "Contact" c ON c.id = o."contactId"
    LEFT JOIN "Posting" po ON po.id = o."postingId"
    LEFT JOIN "ClientCompany" cc ON cc.id = po."clientCompanyId"`;
}

/**
 * Everything that decides whether an opportunity is in the list: org,
 * status, snooze (Active only), stage tab, postings, and search. Status is
 * one status (a keyset branch) or the view's list (counts, name sort).
 */
export function pipelineFilterSql(
  f: PipelineFilter,
  status: OpportunityStatus | OpportunityStatus[],
  { stage = true }: { stage?: boolean } = {},
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`o."orgId" = ${f.orgId}`];
  parts.push(
    Array.isArray(status)
      ? Prisma.sql`o.status IN (${Prisma.join(status.map(statusSql))})`
      : Prisma.sql`o.status = ${statusSql(status)}`,
  );
  // Snoozed candidates are hidden from the Active view until the snooze ends.
  // Columns are timestamp(3) holding UTC, so compare against UTC wall time.
  if (f.view === 'active') {
    parts.push(Prisma.sql`(o."snoozedUntil" IS NULL OR o."snoozedUntil" <= (now() AT TIME ZONE 'UTC'))`);
  }
  if (stage && f.stageId) parts.push(Prisma.sql`o."stageId" = ${f.stageId}`);
  if (f.postingIds) parts.push(Prisma.sql`o."postingId" = ANY(${f.postingIds}::text[])`);
  const q = searchText(f);
  if (q) {
    const p = likePattern(q);
    parts.push(Prisma.sql`(
      c.name ILIKE ${p} ESCAPE '\\' OR c.headline ILIKE ${p} ESCAPE '\\' OR c.location ILIKE ${p} ESCAPE '\\'
      OR po.title ILIKE ${p} ESCAPE '\\' OR cc.name ILIKE ${p} ESCAPE '\\')`);
  }
  return Prisma.join(parts, ' AND ');
}

type RawRow = {
  id: string;
  contactId: string;
  stageId: string;
  stageChangedAt: Date;
  name: string;
  headline: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  link: string | null;
  /** Time sort: stageChangedAt as cursor text. */
  t?: string;
};

/**
 * The row columns both sorts select, from o and c. (The table shows no
 * posting or client, so pages don't join them unless a search needs them.)
 */
const ROW_COLUMNS = Prisma.sql`
  o.id, o."contactId", o."stageId", o."stageChangedAt",
  c.name, c.headline, c.location,
  c.emails[1] AS email, c.phones[1] AS phone, c.links[1] AS link`;

function daysSince(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  return days === 0 ? 'today' : `${days}d`;
}

function toRow(r: RawRow, now: number): PipelineRow {
  const age = now - r.stageChangedAt.getTime();
  return {
    id: r.id,
    contactId: r.contactId,
    name: r.name,
    headline: r.headline,
    location: r.location,
    email: r.email,
    phone: r.phone,
    link: r.link,
    stageId: r.stageId,
    daysInStage: daysSince(age),
    days: Math.floor(age / 86_400_000),
  };
}

function emptyPage(): ListPage<PipelineRow> {
  return { rows: [], endCursor: null, hasMore: false };
}

/**
 * Time in stage, oldest first. Each status is its own branch — a pure
 * ordered range scan of Opportunity_pipeline_stage_idx on a stage tab, or
 * Opportunity_pipeline_all_idx on All stages — and Postgres merges them, so
 * ties break by its own collation, the same one the row-value seek uses.
 */
export function timePageSql(f: PipelineFilter, after: TimeCursor | null, limit: number): Prisma.Sql {
  const seek = after
    ? Prisma.sql`AND o."stageChangedAt" >= ${after.t}::timestamp(3)
        AND (o."stageChangedAt", o.id) > (${after.t}::timestamp(3), ${after.id})`
    : Prisma.empty;
  const branches = VIEW_STATUSES[f.view].map(
    (status) => Prisma.sql`(
      SELECT o.id, o."stageChangedAt" FROM "Opportunity" o ${searchJoins(f)}
      WHERE ${pipelineFilterSql(f, status)} ${seek}
      ORDER BY o."stageChangedAt", o.id
      LIMIT ${intSql(limit + 1)})`,
  );
  return Prisma.sql`
    WITH picked AS (${Prisma.join(branches, ' UNION ALL ')})
    SELECT ${ROW_COLUMNS}, to_char(p."stageChangedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS t
    FROM picked p
    JOIN "Opportunity" o ON o.id = p.id
    JOIN "Contact" c ON c.id = o."contactId"
    ORDER BY p."stageChangedAt", p.id
    LIMIT ${intSql(limit + 1)}`;
}

/**
 * Pages are always read PAGE_SIZE + 1 rows at a time and cut to the size
 * asked for: the SQL, and so its plan, never depends on ?limit. (A LIMIT 2
 * made the planner walk a whole org's name index for a two-row posting.)
 */
async function timePage(f: PipelineFilter, after: TimeCursor | null, n: number) {
  const rows = await db.$queryRaw<RawRow[]>(timePageSql(f, after, PAGE_SIZE));
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  const hasMore = rows.length > n;
  return {
    rows: page,
    endCursor: hasMore && last ? encodeCursor({ v: 1, s: 'time', t: last.t!, id: last.id }) : null,
    hasMore,
  };
}

/**
 * Tiles with at most this many opportunities sort by name from the
 * opportunity side (see namePageSql). It sits near where the two ways cost
 * the same: walking names costs ~ page × contacts / tile probes, sorting the
 * tile costs one probe per opportunity in it.
 */
export const NAME_SMALL = 5_000;
/**
 * The same for a search: counting matches means testing each row's text,
 * so the count stops sooner (a common term would otherwise pay for 5,000
 * matches before its page).
 */
export const NAME_SMALL_SEARCH = 100;

/**
 * By name. Two ways to find a page, and one statement that picks between
 * them from the tile's real size, which the planner can't estimate (it takes
 * status and stage as independent, and a stage with no archived rows looks
 * like thousands):
 *
 * - A tile of at most `small` opportunities (the scope CTE counts up to one
 *   past it, cheaply, on the pipeline indexes) is read whole, each row's
 *   contact name fetched by primary key, and sorted: cost ~ the tile.
 * - A bigger one walks contacts in Contact_name_sort_idx order and looks up
 *   their opportunities, which finds a page after ~ page × contacts / tile
 *   contacts — cheap for a dense tile, and the whole org for an empty one
 *   (2.4 s for an empty tile at 315k contacts, before this).
 *
 * Only one branch runs: each is gated on the count as a one-time filter.
 * The seek is split in two so the (name, id) half is an index condition; a
 * single three-column row compare across the join can't be one.
 */
export function namePageSql(
  f: PipelineFilter,
  after: NameCursor | null,
  limit: number,
  { small = searchText(f) ? NAME_SMALL_SEARCH : NAME_SMALL }: { small?: number } = {},
): Prisma.Sql {
  const seekOn = (id: Prisma.Sql) =>
    after
      ? Prisma.sql`AND (c.name, c.id) >= (${after.n}, ${after.c})
          AND ((c.name, c.id) > (${after.n}, ${after.c}) OR ${id} > ${after.id})`
      : Prisma.empty;
  const statuses = VIEW_STATUSES[f.view];
  return Prisma.sql`
    WITH scope AS MATERIALIZED (
      SELECT o.id, o."contactId" FROM "Opportunity" o ${searchJoins(f)}
      WHERE ${pipelineFilterSql(f, statuses)}
      LIMIT ${intSql(small + 1)}
    ), small AS (SELECT count(*) <= ${intSql(small)} AS yes FROM scope)
    (
      SELECT ${ROW_COLUMNS}
      FROM (
        SELECT s.id FROM scope s
        CROSS JOIN LATERAL (SELECT c.name, c.id FROM "Contact" c WHERE c.id = s."contactId" LIMIT 1) c
        WHERE (SELECT yes FROM small) ${seekOn(Prisma.sql`s.id`)}
        ORDER BY c.name, c.id, s.id
        LIMIT ${intSql(limit + 1)}
      ) t
      JOIN "Opportunity" o ON o.id = t.id
      JOIN "Contact" c ON c.id = o."contactId"
    )
    UNION ALL
    (
      SELECT ${ROW_COLUMNS}
      FROM "Opportunity" o
      JOIN "Contact" c ON c.id = o."contactId" AND c."orgId" = ${f.orgId}
      ${
        searchText(f)
          ? Prisma.sql`LEFT JOIN "Posting" po ON po.id = o."postingId"
      LEFT JOIN "ClientCompany" cc ON cc.id = po."clientCompanyId"`
          : Prisma.empty
      }
      WHERE NOT (SELECT yes FROM small) AND ${pipelineFilterSql(f, statuses)} ${seekOn(Prisma.sql`o.id`)}
      ORDER BY c.name, c.id, o.id
      LIMIT ${intSql(limit + 1)}
    )
    ORDER BY name, "contactId", id
    LIMIT ${intSql(limit + 1)}`;
}

async function namePage(f: PipelineFilter, after: NameCursor | null, n: number, small?: number) {
  const rows = await db.$queryRaw<RawRow[]>(namePageSql(f, after, PAGE_SIZE, { small }));
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  const hasMore = rows.length > n;
  return {
    rows: page,
    endCursor:
      hasMore && last ? encodeCursor({ v: 1, s: 'name', n: last.name, c: last.contactId, id: last.id }) : null,
    hasMore,
  };
}

/** One page of the pipeline, after `after` (the previous page's endCursor). */
export async function pipelinePage(
  f: PipelineFilter,
  sort: PipelineSort,
  {
    after = null,
    limit = PAGE_SIZE,
    nameSmall,
  }: {
    after?: TimeCursor | NameCursor | null;
    limit?: number;
    /** Tests only: force one name-sort strategy (see NAME_SMALL). */
    nameSmall?: number;
  } = {},
): Promise<ListPage<PipelineRow>> {
  if (f.postingIds && f.postingIds.length === 0) return emptyPage();
  const n = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(limit) || PAGE_SIZE));
  const page =
    sort === 'name'
      ? await namePage(f, after?.s === 'name' ? after : null, n, nameSmall)
      : await timePage(f, after?.s === 'time' ? after : null, n);
  const now = Date.now();
  return { rows: page.rows.map((r) => toRow(r, now)), endCursor: page.endCursor, hasMore: page.hasMore };
}

/**
 * Candidates per stage tile, for everything but the stage tab. Without a
 * search this is exact and index-only (Opportunity_pipeline_stage_idx
 * carries snoozedUntil). With one it stops at `cap` matches: past that the
 * per-stage numbers would come from an arbitrary subset, so they are
 * withheld and only "cap+" is reported.
 */
export async function pipelineCounts(
  f: PipelineFilter,
  { cap = COUNT_CAP }: { cap?: number } = {},
): Promise<StageCounts> {
  if (f.postingIds && f.postingIds.length === 0) return { counts: {}, total: 0, capped: false };
  const rows = await db.$queryRaw<{ stageId: string; n: number }[]>(countsSql(f, cap));
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  // Only a search is bounded; without one the counts are exact at any size.
  if (searchText(f) && total > cap) return { counts: {}, total: cap, capped: true };
  return { counts: Object.fromEntries(rows.map((r) => [r.stageId, r.n])), total, capped: false };
}

export function countsSql(f: PipelineFilter, cap = COUNT_CAP): Prisma.Sql {
  const where = pipelineFilterSql(f, VIEW_STATUSES[f.view], { stage: false });
  return searchText(f)
    ? Prisma.sql`
        SELECT s."stageId", count(*)::int AS n FROM (
          SELECT o."stageId" FROM "Opportunity" o ${searchJoins(f)}
          WHERE ${where}
          LIMIT ${intSql(cap + 1)}
        ) s GROUP BY 1`
    : Prisma.sql`
        SELECT o."stageId", count(*)::int AS n FROM "Opportunity" o
        WHERE ${where} GROUP BY 1`;
}

/** Whether anything is in scope at all, ignoring search and the stage tab ("Pipeline is empty"). */
export async function pipelineHasAny(f: PipelineFilter): Promise<boolean> {
  if (f.postingIds && f.postingIds.length === 0) return false;
  const scope = { ...f, q: undefined, stageId: undefined };
  const [row] = await db.$queryRaw<{ any: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "Opportunity" o WHERE ${pipelineFilterSql(scope, VIEW_STATUSES[f.view])}) AS any`;
  return Boolean(row?.any);
}
