/**
 * Shapes the long lists share between the server (pages, route handlers)
 * and the browser (row cache, keyset store). Types only — safe to import
 * from client components.
 */

/** One keyset page. `endCursor` continues after the last row; null when there is nothing after. */
export type ListPage<R> = { rows: R[]; endCursor: string | null; hasMore: boolean };

/** A pipeline row: one opportunity with the contact and posting fields the table shows. */
export type PipelineRow = {
  id: string;
  contactId: string;
  name: string;
  headline: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  link: string | null;
  stageId: string;
  daysInStage: string;
  days: number;
};

/**
 * Per-stage candidate counts for the pipeline's tiles. With a search the
 * count stops at a cap: `capped` means "at least `total`", and the per-stage
 * numbers are withheld rather than shown from a partial count.
 */
export type StageCounts = { counts: Record<string, number>; total: number; capped: boolean };

export type ContactRow = {
  id: string;
  name: string;
  headline: string | null;
  email: string | null;
  tags: string[];
  latestOppId: string | null;
  latestPosting: string | null;
  latestStage: string | null;
  archived: boolean;
};

/** A total that may stop at a cap ("10,000+"). */
export type BoundedCount = { count: number; capped: boolean };
