import { Prisma } from '@prisma/client';
import { ImportAuthError, ImportHttpError, YieldError } from '@/server/imports/http';
import type { Cursor, JsonValue, PhaseContext } from '@/server/imports/types';

/**
 * Errors that mean "try this slice again later", not "this record is bad":
 * time budget, auth, rate limits/outages, and database connectivity.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof YieldError || err instanceof ImportAuthError) return true;
  if (err instanceof ImportHttpError) return err.status === 0 || err.status === 429 || err.status >= 500;
  if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientRustPanicError) return true;
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    // Postgres rejecting a value (bad encoding, out of range, too long) is about the record, not the database.
    return !/\b22[0-9A-Z]{3}\b|invalid byte sequence|unicode escape|hex escape|out of range|too long/i.test(err.message);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P1xxx: connectivity. P2024: pool timeout. P2028/P2034: transaction aborted/conflict.
    return err.code.startsWith('P1') || ['P2024', 'P2028', 'P2034'].includes(err.code);
  }
  return false;
}

/**
 * Handle one vendor record. A record that can't be imported (malformed
 * payload, a value Postgres rejects, a 404 on its sub-resource) is skipped
 * with a warning instead of failing the job — otherwise every retry would
 * replay the same record and the whole import would die on it.
 */
export async function each<T>(ctx: PhaseContext, item: T, handle: (item: T) => Promise<void>) {
  try {
    await handle(item);
  } catch (err) {
    if (isRetryable(err)) throw err;
    const id = (item as { id?: unknown })?.id;
    // Prisma messages open with a blank line and a call site; show the code or the last line instead.
    const reason =
      err instanceof Prisma.PrismaClientKnownRequestError
        ? `database rejected a value (${err.code})`
        : err instanceof Error
          ? (err.message.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? err.name).slice(0, 300)
          : String(err);
    ctx.warn(`Skipped a record that could not be imported: ${reason}`, id != null ? { externalId: String(id) } : undefined);
  }
}

/**
 * The step shape almost every phase shares: fetch one page, handle its items
 * one by one, and stop early — mid-page if need be — when the slice runs out
 * of time. The cursor remembers both the page token and how far into the page
 * we got, so a resumed step refetches the same page and skips what's done.
 *
 * `page` is whatever the vendor needs to fetch a page (offset token, cursor,
 * page number, next URL); null means the first page.
 */
export type PageCursor = { page: JsonValue; index: number };

export type Page<T> = { items: T[]; next: JsonValue };

export async function pagedStep<T>(
  ctx: PhaseContext,
  cursor: Cursor | null,
  fetchPage: (page: JsonValue) => Promise<Page<T>>,
  handle: (item: T) => Promise<void>,
): Promise<Cursor | null> {
  const at = (cursor as PageCursor | null) ?? { page: null, index: 0 };
  const { items, next } = await fetchPage(at.page);
  for (let i = at.index; i < items.length; i++) {
    // Always make progress: at least one item per step even if already late.
    if (i > at.index && ctx.outOfTime()) return { page: at.page, index: i };
    await each(ctx, items[i], handle);
  }
  return next === null || next === undefined || items.length === 0 ? null : { page: next, index: 0 };
}

/**
 * Iterate a fixed list (e.g. every job id, to fetch its per-job stages)
 * with the same resume-anywhere semantics. `list` must be deterministic
 * across steps — derive it from data the step can re-read.
 */
export async function listStep<T>(
  ctx: PhaseContext,
  cursor: Cursor | null,
  list: T[],
  handle: (item: T) => Promise<void>,
): Promise<Cursor | null> {
  const start = typeof cursor === 'number' ? cursor : 0;
  for (let i = start; i < list.length; i++) {
    if (i > start && ctx.outOfTime()) return i;
    await each(ctx, list[i], handle);
  }
  return null;
}

/** Run an optional sub-fetch; on 404 or missing permission, warn and continue. */
export async function optional<T>(
  ctx: PhaseContext,
  what: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 404) {
      ctx.warn(`${what}: ${(err as Error).message}`);
      return fallback;
    }
    throw err;
  }
}
