/**
 * Search and filters for the public job board (careers/[org]). Pure, so the
 * server renders a shared link's filtered board and the client filters as
 * people type, with the same rules. The state lives in the URL:
 * ?q=design&team=Design&location=New+York%2C+NY&workplace=remote&type=full-time
 * (`client` instead of `team` on an agency's board).
 */

export type BoardPosting = {
  id: string;
  slug: string;
  title: string;
  location: string | null;
  workplaceType: string;
  commitment: string;
  /** The department, or the client on an agency's board. */
  group: string;
};

export type BoardFilters = { q: string; group: string; location: string; workplace: string; type: string };
export type BoardFacet = Exclude<keyof BoardFilters, 'q'>;

export const EMPTY_FILTERS: BoardFilters = { q: '', group: '', location: '', workplace: '', type: '' };

export const WORKPLACE_LABELS: Record<string, string> = { ONSITE: 'On-site', HYBRID: 'Hybrid', REMOTE: 'Remote' };
export const COMMITMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
  INTERNSHIP: 'Internship',
};

/** An enum value as it reads in a URL: FULL_TIME → full-time. */
export const slugOf = (value: string) => value.toLowerCase().replace(/_/g, '-');

/** A posting's value for one facet, in its URL form. */
export function facetValue(p: BoardPosting, facet: BoardFacet): string {
  if (facet === 'group') return p.group;
  if (facet === 'location') return p.location ?? '';
  if (facet === 'workplace') return slugOf(p.workplaceType);
  return slugOf(p.commitment);
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 200) ?? '';

export function readBoardFilters(params: Record<string, string | string[] | undefined>, groupKey: string): BoardFilters {
  return {
    q: one(params.q),
    group: one(params[groupKey]),
    location: one(params.location),
    workplace: one(params.workplace),
    type: one(params.type),
  };
}

/**
 * Filters from a URL, less any value the board doesn't have (an old link to
 * a closed role's team): otherwise it would hide every role behind a filter
 * no menu shows.
 */
export function knownFilters(postings: BoardPosting[], f: BoardFilters): BoardFilters {
  const known = (facet: BoardFacet) => (postings.some((p) => facetValue(p, facet) === f[facet]) ? f[facet] : '');
  return { q: f.q, group: known('group'), location: known('location'), workplace: known('workplace'), type: known('type') };
}

/** The query string for a set of filters: empty ones left out. */
export function boardSearch(filters: BoardFilters, groupKey: string): string {
  const params = new URLSearchParams();
  const pairs: [string, string][] = [
    ['q', filters.q.trim()],
    [groupKey, filters.group],
    ['location', filters.location],
    ['workplace', filters.workplace],
    ['type', filters.type],
  ];
  for (const [k, v] of pairs) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Lowercased, accents off: "Zürich" matches "zurich". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Every word of the search appears somewhere in the role's title, team, location or kind of work. */
function matchesQuery(p: BoardPosting, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(
    [p.title, p.group, p.location ?? '', WORKPLACE_LABELS[p.workplaceType] ?? '', COMMITMENT_LABELS[p.commitment] ?? ''].join(' '),
  );
  return words.every((w) => hay.includes(w));
}

/** The postings that pass every filter, except `skip` (for a facet's own counts). */
export function filterPostings(postings: BoardPosting[], f: BoardFilters, skip?: BoardFacet): BoardPosting[] {
  const facets: BoardFacet[] = ['group', 'location', 'workplace', 'type'];
  return postings.filter(
    (p) => matchesQuery(p, f.q) && facets.every((k) => k === skip || !f[k] || facetValue(p, k) === f[k]),
  );
}

export type FacetOption = { value: string; label: string; count: number };

/**
 * A facet's choices: every value on the board, each counted against the
 * other filters, so a count says what picking it would show. Empty when the
 * board has only one value (nothing to choose between).
 */
export function facetOptions(postings: BoardPosting[], f: BoardFilters, facet: BoardFacet): FacetOption[] {
  const values = new Map<string, string>();
  for (const p of postings) {
    const v = facetValue(p, facet);
    if (!v) continue;
    const label =
      facet === 'workplace' ? WORKPLACE_LABELS[p.workplaceType] : facet === 'type' ? COMMITMENT_LABELS[p.commitment] : v;
    values.set(v, label ?? v);
  }
  if (values.size < 2) return [];
  const pool = filterPostings(postings, f, facet);
  return [...values.entries()]
    .map(([value, label]) => ({ value, label, count: pool.filter((p) => facetValue(p, facet) === value).length }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
