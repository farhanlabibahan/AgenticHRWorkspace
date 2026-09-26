/**
 * The parsed resume as the profile shows it: experience, education, skills
 * and the candidate's own summary, read from StoredFile.parsed (written by
 * src/server/resume-parse, validated there). Read defensively anyway: the
 * column is JSON, and an older or hand-edited row must never break a page.
 */

export type ProfileJob = { title: string | null; company: string | null; location: string | null; start: string | null; end: string | null };
export type ProfileSchool = { school: string | null; degree: string | null; field: string | null; start: string | null; end: string | null };

export type ResumeView = {
  summary: string | null;
  skills: string[];
  experience: ProfileJob[];
  education: ProfileSchool[];
};

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

/** The parsed profile, or null when there's nothing worth showing. */
export function readResumeView(raw: unknown): ResumeView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const view: ResumeView = {
    summary: str(p.summary, 1_200),
    skills: Array.isArray(p.skills) ? [...new Set(p.skills.map((s) => str(s, 60)).filter((s): s is string => !!s))].slice(0, 40) : [],
    experience: list(p.experience)
      .map((j) => ({ title: str(j.title, 150), company: str(j.company, 150), location: str(j.location, 120), start: str(j.start, 10), end: str(j.end, 10) }))
      .filter((j) => j.title || j.company)
      .slice(0, 20),
    education: list(p.education)
      .map((e) => ({ school: str(e.school, 150), degree: str(e.degree, 150), field: str(e.field, 150), start: str(e.start, 10), end: str(e.end, 10) }))
      .filter((e) => e.school || e.degree)
      .slice(0, 10),
  };
  return view.summary || view.skills.length || view.experience.length || view.education.length ? view : null;
}

/** "2019-04" → months since year 0; "2019" → January (or December for an end); "present" → now. */
function toMonth(value: string | null, { end, now }: { end: boolean; now: Date }): number | null {
  if (!value) return null;
  if (value === 'present') return now.getFullYear() * 12 + now.getMonth();
  const m = value.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) - 1 : end ? 11 : 0;
  return Number(m[1]) * 12 + month;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Apr 2019", "2019" or "Present". */
export function formatResumeDate(value: string | null): string | null {
  if (!value) return null;
  if (value === 'present') return 'Present';
  const m = value.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return value;
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}

/** "Apr 2019 – Present", "2017 – 2019", or one side when that's all there is. */
export function formatSpan(start: string | null, end: string | null): string | null {
  const a = formatResumeDate(start);
  const b = formatResumeDate(end);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a ?? b;
}

/** "2 yrs 3 mos", "8 mos", or null when either end is unknown. */
export function formatDuration(start: string | null, end: string | null, now = new Date()): string | null {
  const a = toMonth(start, { end: false, now });
  const b = toMonth(end, { end: true, now });
  if (a === null || b === null || b < a) return null;
  // Year-only dates are coarse: don't claim month precision from them.
  const coarse = !/-/.test(start ?? '') || (end !== 'present' && !/-/.test(end ?? ''));
  const months = b - a + 1;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (coarse) return years >= 1 ? `${years} yr${years === 1 ? '' : 's'}` : null;
  const y = years ? `${years} yr${years === 1 ? '' : 's'}` : '';
  const m = rest ? `${rest} mo${rest === 1 ? '' : 's'}` : '';
  return [y, m].filter(Boolean).join(' ') || null;
}

/**
 * Whole years worked, counting overlapping jobs once: the union of every
 * dated role. Null when no role has both ends.
 */
export function yearsOfExperience(jobs: ProfileJob[], now = new Date()): number | null {
  const spans = jobs
    .map((j) => [toMonth(j.start, { end: false, now }), toMonth(j.end, { end: true, now })] as const)
    .filter((s): s is readonly [number, number] => s[0] !== null && s[1] !== null && s[1] >= s[0])
    .map(([a, b]) => [a, b] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  if (!spans.length) return null;
  let months = 0;
  let [curA, curB] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a <= curB + 1) curB = Math.max(curB, b);
    else {
      months += curB - curA + 1;
      [curA, curB] = [a, b];
    }
  }
  months += curB - curA + 1;
  return Math.floor(months / 12);
}

export type CompanyStint = {
  company: string | null;
  /** Most recent first, as the resume lists them. */
  roles: ProfileJob[];
  start: string | null;
  end: string | null;
};

const sameCompany = (a: string | null, b: string | null) =>
  !!a && !!b && a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Consecutive roles at one company as a single stint, so a promotion reads
 * as one company with two titles rather than two separate jobs.
 */
export function groupByCompany(jobs: ProfileJob[]): CompanyStint[] {
  const stints: CompanyStint[] = [];
  for (const job of jobs) {
    const last = stints[stints.length - 1];
    if (last && sameCompany(last.company, job.company)) {
      last.roles.push(job);
      last.start = job.start ?? last.start;
    } else {
      stints.push({ company: job.company, roles: [job], start: job.start, end: job.end });
    }
  }
  return stints;
}
