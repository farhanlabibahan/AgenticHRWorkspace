import { groupByCompany, type ProfileJob } from '@/lib/resume-profile';

/**
 * Career highlights on the profile: a few short signals about someone's
 * path. Promotions and long tenure are counted from the parsed resume; the
 * rest ("0 to 1 launches", "Startup and big tech") come from the latest
 * evaluation (AiEvaluation.highlights), each tagged with a kind for its icon.
 */

export const HIGHLIGHT_KINDS = ['growth', 'launch', 'scale', 'leadership', 'range', 'craft', 'tenure', 'other'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];
export type Highlight = { kind: HighlightKind; text: string };

export const MAX_AI_HIGHLIGHTS = 3;

export function readHighlights(raw: unknown): Highlight[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
    .map((h) => ({
      kind: (HIGHLIGHT_KINDS as readonly string[]).includes(String(h.kind)) ? (h.kind as HighlightKind) : 'other',
      text: typeof h.text === 'string' ? h.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    }))
    .filter((h) => h.text)
    .slice(0, MAX_AI_HIGHLIGHTS);
}

const TIMES = ['', 'once', 'twice', 'three times', 'four times'];

/** Months between two resume dates ("2019-04", "2019", "present"); null when unknown. */
function months(start: string | null, end: string | null, now: Date): number | null {
  const at = (v: string | null, isEnd: boolean) => {
    if (v === 'present') return now.getFullYear() * 12 + now.getMonth();
    const m = v?.match(/^(\d{4})(?:-(\d{2}))?$/);
    if (!m) return null;
    return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : isEnd ? 11 : 0);
  };
  const a = at(start, false);
  const b = at(end, true);
  return a === null || b === null || b < a ? null : b - a + 1;
}

/** What the resume shows without reading between the lines: promotions and long stays. */
export function resumeHighlights(experience: ProfileJob[], now = new Date()): Highlight[] {
  const stints = groupByCompany(experience).filter((s) => s.company);
  const out: Highlight[] = [];
  const promoted = stints.filter((s) => s.roles.length > 1);
  const promotions = promoted.reduce((n, s) => n + s.roles.length - 1, 0);
  if (promotions === 1) out.push({ kind: 'growth', text: `Promoted at ${promoted[0].company}` });
  else if (promoted.length === 1 && promotions > 1) {
    out.push({ kind: 'growth', text: `Promoted ${TIMES[promotions] ?? `${promotions} times`} at ${promoted[0].company}` });
  } else if (promotions > 1) out.push({ kind: 'growth', text: `Promoted ${TIMES[promotions] ?? `${promotions} times`}` });

  const longest = stints
    .map((s) => ({ s, m: months(s.start, s.end, now) }))
    .filter((x): x is { s: (typeof stints)[number]; m: number } => x.m !== null)
    .sort((a, b) => b.m - a.m)[0];
  if (longest && longest.m >= 48) {
    out.push({ kind: 'tenure', text: `${Math.floor(longest.m / 12)} years at ${longest.s.company}` });
  }
  return out;
}

/** Resume-derived first, then the evaluation's, without repeating a promotion. */
export function mergeHighlights(fromResume: Highlight[], fromEvaluation: Highlight[]): Highlight[] {
  const hasGrowth = fromResume.some((h) => h.kind === 'growth');
  const seen = new Set(fromResume.map((h) => h.text.toLowerCase()));
  const rest = fromEvaluation.filter(
    (h) => !seen.has(h.text.toLowerCase()) && !(hasGrowth && /promot/i.test(h.text)),
  );
  return [...fromResume, ...rest];
}
