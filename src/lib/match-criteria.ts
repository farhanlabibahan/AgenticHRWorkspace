import type { Tone } from '@/components/ui/primitives';

/**
 * A role's match criteria (Posting.matchCriteria) and how a candidate
 * scored on each (AiEvaluation.criteria). Every candidate for a role is
 * scored on the same list; an evaluation keeps a copy of each criterion's
 * wording, so editing the list later never rewrites a past result.
 *
 * The overall match is computed here from the per-criterion scores, not
 * reported by the model, so it's always explainable from the chips.
 */

export type MatchCriterion = { id: string; label: string; must: boolean };
export type CriterionResult = MatchCriterion & {
  /** 0, 25, 50, 75 or 100; null when the material says nothing about it. */
  score: number | null;
  evidence: string;
};

export const MAX_CRITERIA = 12;
export const MAX_LABEL = 80;

const newId = () => Math.random().toString(36).slice(2, 10);

/** A criteria list from JSON or a form: trimmed, deduplicated, bounded; ids kept or made. */
export function cleanCriteria(raw: unknown): MatchCriterion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MatchCriterion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const label = typeof c.label === 'string' ? c.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    const id = typeof c.id === 'string' && /^[\w-]{1,32}$/.test(c.id) ? c.id : newId();
    out.push({ id, label, must: c.must === true });
    if (out.length === MAX_CRITERIA) break;
  }
  return out;
}

/** 0–100 onto the five steps the chips show. */
export function snapScore(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n / 25) * 25));
}

/** Stored results from JSON, bounded; anything unreadable is dropped. */
export function readCriterionResults(raw: unknown): CriterionResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : newId(),
      label: typeof r.label === 'string' ? r.label.slice(0, MAX_LABEL) : '',
      must: r.must === true,
      score: r.score === null ? null : snapScore(r.score),
      evidence: typeof r.evidence === 'string' ? r.evidence.slice(0, 400) : '',
    }))
    .filter((r) => r.label)
    .slice(0, MAX_CRITERIA);
}

/** Must-haves count double; a criterion with no evidence counts as 0. Null with no criteria. */
export function computeMatchScore(results: Pick<CriterionResult, 'must' | 'score'>[]): number | null {
  if (!results.length) return null;
  let total = 0;
  let weight = 0;
  for (const r of results) {
    const w = r.must ? 2 : 1;
    total += (r.score ?? 0) * w;
    weight += w;
  }
  return Math.round(total / weight);
}

export function scoreTone(score: number | null): Tone {
  if (score === null) return 'neutral';
  if (score >= 75) return 'positive';
  if (score >= 50) return 'caution';
  return 'critical';
}

/** Must-haves first, then by the order the role lists them. */
export function orderResults<T extends { must: boolean }>(results: T[]): T[] {
  return [...results.filter((r) => r.must), ...results.filter((r) => !r.must)];
}
