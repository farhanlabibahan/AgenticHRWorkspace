/**
 * A list's canonical query string: its whitelisted params in a fixed order,
 * empties dropped, the search trimmed, never a cursor. It is both the URL a
 * list link points at and the key its rows are cached under, so the two can
 * never drift apart.
 */

export const PIPELINE_KEYS = ['status', 'posting', 'client', 'stage', 'q', 'sort'] as const;
export const CONTACT_KEYS = ['pool', 'tag', 'q'] as const;

export type ListInput<K extends string> = Partial<Record<K, string>>;

export function listKey<K extends string>(input: ListInput<K>, keys: readonly K[]): string {
  const params = new URLSearchParams();
  for (const k of keys) {
    const raw = input[k];
    const v = k === 'q' ? raw?.trim() : raw;
    if (v) params.set(k, v);
  }
  return params.toString();
}

/** The same params, as the list input they encode. */
export function inputFromKey<K extends string>(key: string, keys: readonly K[]): ListInput<K> {
  const params = new URLSearchParams(key);
  const out: ListInput<K> = {};
  for (const k of keys) {
    const v = params.get(k);
    if (v) out[k] = v;
  }
  return out;
}

export function listHref(basePath: string, key: string): string {
  return key ? `${basePath}?${key}` : basePath;
}
