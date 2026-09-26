/**
 * Per-call caps for bulk server actions — each call stays well inside a
 * function's time limit. Paged lists let a selection grow past these, so the
 * client sends larger selections in chunks (runOptimisticBulk) instead of
 * the server silently dropping the rest.
 */
export const BULK_LIMIT = 100;
export const POOL_BULK_LIMIT = 200;

/** What a bulk action reports back: how many of the ids it was sent it left alone. */
export type BulkResult = { skipped: number };
