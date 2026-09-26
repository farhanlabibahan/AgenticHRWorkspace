import { NextResponse } from 'next/server';
import { PAGE_SIZE } from '@/server/lists/pipeline';

/**
 * Shared by the /api/lists routes. Only whitelisted params are read, each
 * as its first string value, so nothing else ever reaches a query. The
 * search is trimmed, as the list key and the page loaders trim it.
 */
export function listParams<K extends string>(params: URLSearchParams, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    // NUL can't be stored or compared in Postgres text: drop it, never 500.
    let v = params.get(k)?.replaceAll('\u0000', '');
    if (k === 'q') v = v?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** ?limit, clamped to 1..PAGE_SIZE (PAGE_SIZE when missing or not a number). */
export function limitParam(params: URLSearchParams): number {
  const n = Number.parseInt(params.get('limit') ?? '', 10);
  return Number.isFinite(n) ? Math.min(PAGE_SIZE, Math.max(1, n)) : PAGE_SIZE;
}

/** Rows are per-user and change with every edit: never cache them anywhere. */
export function listJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
