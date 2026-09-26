import { createHash } from 'crypto';

/**
 * Re-imports: a second import from the same account updates what changed at
 * the vendor since the last one, and never what the team changed in Source.
 *
 * Every ImportRef keeps the Source values its record was mapped to at the
 * last import (the snapshot). On the next import each field is a three-way
 * merge: base = snapshot, ours = the Source record now, theirs = the vendor
 * record mapped again.
 *   theirs = base                  → the vendor didn't change it: leave ours.
 *   theirs ≠ base, ours = base     → only the vendor changed it: take theirs.
 *   theirs ≠ base, ours ≠ base     → both changed it: the team's edit stays.
 * Lists (emails, phones, links, tags) only grow: what's new at the vendor is
 * added, nothing is removed.
 *
 * Refs from before re-imports have no snapshot. Where the Source record
 * provably hasn't been touched since the import wrote it, ours is the base;
 * otherwise the base is unknown and a field is only filled when it's empty.
 */

/** JSON with sorted keys and Dates as ISO strings: equal records, equal strings. */
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => typeof (value as Record<string, unknown>)[k] !== 'function')
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value === undefined ? null : value;
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** Plain JSON for a snapshot column. */
export function snapshotOf(values: Record<string, unknown>): Record<string, unknown> {
  return stable(values) as Record<string, unknown>;
}

/** Hash of a vendor record as the adapter handed it over (download functions ignored). */
export function fingerprint(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(record))).digest('base64url').slice(0, 32);
}

const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

export type Merged<T> = { value: T; changed: boolean; kept: boolean };

/**
 * One field. `base` undefined means unknown (a ref from before re-imports on
 * a record that has been touched since): then theirs only fills an empty field.
 */
export function mergeField<T>(base: T | undefined, ours: T, theirs: T, baseKnown: boolean): Merged<T> {
  if (same(ours, theirs)) return { value: ours, changed: false, kept: false };
  if (!baseKnown) {
    return empty(ours) ? { value: theirs, changed: true, kept: false } : { value: ours, changed: false, kept: true };
  }
  if (same(theirs, base)) return { value: ours, changed: false, kept: false };
  if (same(ours, base)) return { value: theirs, changed: true, kept: false };
  return { value: ours, changed: false, kept: true };
}

/** A list that only grows: what the vendor added since the base, not already in ours. */
export function mergeList(base: string[] | undefined, ours: string[], theirs: string[], baseKnown: boolean): Merged<string[]> {
  const had = new Set((baseKnown ? base ?? [] : []).map((v) => v.toLowerCase()));
  const present = new Set(ours.map((v) => v.toLowerCase()));
  const added = theirs.filter((v) => !had.has(v.toLowerCase()) && !present.has(v.toLowerCase()));
  const unique = [...new Map(added.map((v) => [v.toLowerCase(), v])).values()];
  return { value: unique.length ? [...ours, ...unique] : ours, changed: unique.length > 0, kept: false };
}

/**
 * Merge a record's fields. `lists` names the fields that only grow. Returns
 * the fields to write (only the changed ones) and how many kept the team's edit.
 */
export function mergeRecord<T extends Record<string, unknown>>(
  base: Partial<T> | null,
  ours: T,
  theirs: T,
  opts: { baseKnown: boolean; lists?: (keyof T)[] },
): { update: Partial<T>; kept: (keyof T)[] } {
  const update: Partial<T> = {};
  const kept: (keyof T)[] = [];
  for (const key of Object.keys(theirs) as (keyof T)[]) {
    const merged = opts.lists?.includes(key)
      ? mergeList(base?.[key] as string[] | undefined, (ours[key] as string[]) ?? [], (theirs[key] as string[]) ?? [], opts.baseKnown)
      : mergeField(base?.[key], ours[key], theirs[key], opts.baseKnown);
    if (merged.changed) update[key] = merged.value as T[keyof T];
    if (merged.kept) kept.push(key);
  }
  return { update, kept };
}

/**
 * Whether a Source record is still exactly as an import wrote it: nothing
 * has updated it since its ref was created (a minute of slack for the rest
 * of that step). Only for records the import created and that have updatedAt.
 */
export function untouchedSince(updatedAt: Date | null | undefined, refCreatedAt: Date): boolean {
  return !!updatedAt && updatedAt.getTime() <= refCreatedAt.getTime() + 60_000;
}
