import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** What Next passes a page as `searchParams`. */
/**
 * Longest person name we store. Names are indexed in a btree (the pipeline's
 * sort by name), and a btree entry must stay under ~2,700 bytes: 500
 * characters is at most 2,000 bytes of UTF-8.
 */
export const MAX_NAME_LENGTH = 500;

/** A name cut to MAX_NAME_LENGTH characters (whole code points, never half an emoji). */
export function capName(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name;
  const chars = Array.from(name);
  return chars.length > MAX_NAME_LENGTH ? chars.slice(0, MAX_NAME_LENGTH).join('') : name;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Page searchParams, one string per key. A repeated key (?q=a&q=b) arrives as
 * an array; like URLSearchParams.get, keep the first.
 */
export async function firstParams(params: SearchParams): Promise<Record<string, string | undefined>> {
  const raw = await params;
  return Object.fromEntries(
    // NUL can't be stored or compared in Postgres text; a URL carrying one
    // must not turn into a server error.
    Object.entries(raw).map(([k, v]) => [k, (Array.isArray(v) ? v[0] : v)?.replaceAll('\u0000', '')]),
  );
}
