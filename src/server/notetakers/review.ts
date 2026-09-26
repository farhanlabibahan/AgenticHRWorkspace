import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { visibleOpportunityWhere } from '@/server/notetakers/binding';
import { attendeeEmailSet, attendeeNameSet, fullNameKey, nameKey, type MatchReason } from '@/server/notetakers/match';

/**
 * "Transcripts to review" on the Interviews page: for each meeting the sync
 * set aside (SUGGESTED), which person it was with. Nothing here is stored:
 * the choices are worked out when the page renders, from the meeting's
 * participants and the viewer's interviews, so they're always current.
 *
 *  - Attach to: every interview the viewer sits on or owns within two hours
 *    of the meeting, each with why it's there (a candidate email in the
 *    meeting, the candidate's name in it, or only the time), strongest first.
 *  - People named X: candidates anywhere in the org whose full name is a
 *    participant's, so a name match beyond those two hours is one click, and
 *    two people with one name sit side by side with their emails and roles.
 *  - Someone else: a search over the candidates the viewer may see, prefilled
 *    with the participants who aren't teammates.
 *
 * The pure parts (options, reasons, preselection, the same-name warning) are
 * unit-tested in tests/notetaker-review.test.ts.
 */

const HOUR = 3_600_000;

/** How far from the meeting an interview can start and still be offered. */
export const OPTION_WINDOW_MS = 2 * HOUR;

/** A candidate as the card shows them: enough to tell two people with one name apart. */
export type CandidateSummary = { contactId: string; name: string; email: string | null; postingTitle: string | null };

export type InterviewForOptions = {
  id: string;
  opportunityId: string;
  title: string;
  startAt: Date;
  candidate: CandidateSummary & { emails: string[] };
};

export type AttachOption = {
  interviewId: string;
  opportunityId: string;
  interviewTitle: string;
  startAt: string;
  reason: MatchReason;
  candidate: CandidateSummary;
};

export type MeetingEvidence = { startAt: Date; attendeeEmails: string[]; attendeeNames: string[] };

const REASON_RANK: Record<MatchReason, number> = { email: 0, name: 1, time: 2 };

/** Why this candidate is offered for this meeting: their email, their full name, or neither (only the time). */
export function reasonFor(meeting: Pick<MeetingEvidence, 'attendeeEmails' | 'attendeeNames'>, candidate: { emails: string[]; name: string }): MatchReason {
  const emails = attendeeEmailSet(meeting.attendeeEmails);
  if (candidate.emails.some((e) => emails.has(e.trim().toLowerCase()))) return 'email';
  const key = fullNameKey(candidate.name);
  if (key && attendeeNameSet(meeting.attendeeNames).has(key)) return 'name';
  return 'time';
}

/**
 * The interviews offered for a meeting: those within the window, strongest
 * reason first (email, then name), then the closest in time. The first one
 * is preselected; nothing is attached until a person presses Attach.
 */
export function buildAttachOptions(
  meeting: MeetingEvidence,
  interviews: InterviewForOptions[],
  windowMs = OPTION_WINDOW_MS,
): { options: AttachOption[]; preselect: string | null } {
  const t = meeting.startAt.getTime();
  const ranked = interviews
    .map((iv) => ({ iv, gap: Math.abs(iv.startAt.getTime() - t), reason: reasonFor(meeting, iv.candidate) }))
    .filter((x) => x.gap <= windowMs)
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.gap - b.gap || a.iv.id.localeCompare(b.iv.id));
  const options = ranked.map(({ iv, reason }) => ({
    interviewId: iv.id,
    opportunityId: iv.opportunityId,
    interviewTitle: iv.title,
    startAt: iv.startAt.toISOString(),
    reason,
    candidate: { contactId: iv.candidate.contactId, name: iv.candidate.name, email: iv.candidate.email, postingTitle: iv.candidate.postingTitle },
  }));
  return { options, preselect: options[0]?.interviewId ?? null };
}

export type SameNameWarning = { name: string; count: number };

/**
 * Names shared by two or more different candidates among those offered
 * (case- and whitespace-insensitive). One candidate with two interviews is
 * still one person.
 */
export function sameNameWarnings(candidates: { contactId: string; name: string }[]): SameNameWarning[] {
  const groups = new Map<string, { name: string; ids: Set<string> }>();
  for (const c of candidates) {
    const key = nameKey(c.name);
    if (!key) continue;
    const g = groups.get(key) ?? { name: c.name.trim().replace(/\s+/g, ' '), ids: new Set<string>() };
    g.ids.add(c.contactId);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.ids.size > 1).map((g) => ({ name: g.name, count: g.ids.size }));
}

/** Who was in the meeting, as the notetaker knows them: names when it has them, else emails. */
export function participantsOf(meeting: { attendeeNames: string[]; attendeeEmails: string[] }): string[] {
  return meeting.attendeeNames.length ? meeting.attendeeNames : meeting.attendeeEmails;
}

/**
 * Quick picks for the search: participants who aren't on the team (the
 * viewer included), by name, or by email when the notetaker knows no names.
 */
export function quickPicks(
  meeting: { attendeeNames: string[]; attendeeEmails: string[] },
  team: { names: Set<string>; emails: Set<string> },
  max = 6,
): string[] {
  const out = new Map<string, string>();
  for (const name of meeting.attendeeNames) {
    const key = nameKey(name);
    if (key.length >= 2 && !team.names.has(key)) out.set(key, name.trim().replace(/\s+/g, ' '));
  }
  if (!out.size) {
    for (const email of meeting.attendeeEmails) {
      const key = email.trim().toLowerCase();
      if (key && !team.emails.has(key)) out.set(key, key);
    }
  }
  return [...out.values()].slice(0, max);
}

// ---------- people, for "People named X" and the search ----------

export type PersonApplication = {
  opportunityId: string;
  postingTitle: string | null;
  archived: boolean;
  interviews: { id: string; title: string; startAt: string }[];
};

export type PersonTarget = {
  contactId: string;
  name: string;
  email: string | null;
  /** The latest application's role, and how many others there are. */
  role: string | null;
  moreRoles: number;
  /** Their next interview, or else the most recent. */
  interview: { when: 'next' | 'last'; title: string; startAt: string } | null;
  applications: PersonApplication[];
};

export const personSelect = (orgId: string) =>
  ({
    id: true,
    name: true,
    emails: true,
    opportunities: {
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true,
        status: true,
        posting: { select: { title: true } },
        interviews: {
          where: { state: { not: 'CANCELED' } },
          orderBy: { startAt: 'desc' },
          take: 12,
          select: { id: true, title: true, startAt: true },
        },
      },
    },
  }) satisfies Prisma.ContactSelect;

type PersonRow = Prisma.ContactGetPayload<{ select: ReturnType<typeof personSelect> }>;

export function personTargetOf(row: PersonRow, now: Date): PersonTarget {
  const apps = row.opportunities;
  const all = apps.flatMap((o) => o.interviews);
  const next = all.filter((iv) => iv.startAt >= now).sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
  const last = all.filter((iv) => iv.startAt < now).sort((a, b) => b.startAt.getTime() - a.startAt.getTime())[0];
  const hint = next ? { when: 'next' as const, iv: next } : last ? { when: 'last' as const, iv: last } : null;
  return {
    contactId: row.id,
    name: row.name,
    email: row.emails[0] ?? null,
    role: apps[0]?.posting?.title ?? null,
    moreRoles: Math.max(0, apps.length - 1),
    interview: hint ? { when: hint.when, title: hint.iv.title, startAt: hint.iv.startAt.toISOString() } : null,
    applications: apps.map((o) => ({
      opportunityId: o.id,
      postingTitle: o.posting?.title ?? null,
      archived: o.status === 'ARCHIVED',
      interviews: o.interviews.map((iv) => ({ id: iv.id, title: iv.title, startAt: iv.startAt.toISOString() })),
    })),
  };
}

/** Candidates the viewer may see who have an application to attach to. */
function visibleContactWhere(ctx: SessionContext): Prisma.ContactWhereInput {
  return { orgId: ctx.orgId, isAnonymized: false, opportunities: { some: visibleOpportunityWhere(ctx) } };
}

/**
 * Candidates whose full name is one of `keys`. The trigram index narrows by
 * the first and last words; the exact key is checked here, since a name can
 * carry double spaces or different case.
 */
async function contactsNamed(ctx: SessionContext, keys: string[]): Promise<PersonRow[]> {
  if (!keys.length) return [];
  const rows = await db.contact.findMany({
    where: {
      ...visibleContactWhere(ctx),
      OR: keys.map((key) => {
        const words = key.split(' ');
        return {
          AND: [
            { name: { contains: words[0], mode: 'insensitive' as const } },
            { name: { contains: words[words.length - 1], mode: 'insensitive' as const } },
          ],
        };
      }),
    },
    select: personSelect(ctx.orgId),
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  const wanted = new Set(keys);
  return rows.filter((r) => {
    const key = fullNameKey(r.name);
    return key !== null && wanted.has(key);
  });
}

export const SEARCH_LIMIT = 8;

/** "Someone else…": candidates the viewer may see, by name (any part) or by exact email. */
export async function searchAttachCandidates(ctx: SessionContext, query: string, now = new Date()): Promise<PersonTarget[]> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (q.length < 2) return [];
  const rows = await db.contact.findMany({
    where: {
      ...visibleContactWhere(ctx),
      OR: [{ name: { contains: q, mode: 'insensitive' } }, { emails: { has: q.toLowerCase() } }],
    },
    select: personSelect(ctx.orgId),
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: SEARCH_LIMIT,
  });
  return rows.map((r) => personTargetOf(r, now));
}

// ---------- the cards ----------

export type PeopleNamed = {
  /** The participant's name as the notetaker wrote it. */
  name: string;
  /** Someone of this name is among the interviews above ("Other people named …"). */
  alsoAbove: boolean;
  people: PersonTarget[];
};

export type ReviewMeeting = {
  id: string;
  provider: string;
  title: string;
  startAt: string;
  durationMins: number | null;
  participants: string[];
  options: AttachOption[];
  preselect: string | null;
  sameName: SameNameWarning[];
  peopleNamed: PeopleNamed[];
  quickPicks: string[];
};

/** "People named X" for one meeting: every participant's full name that a visible candidate has. */
export function peopleNamedFor(
  meeting: { attendeeNames: string[] },
  options: AttachOption[],
  named: PersonRow[],
  opts: { viewerNameKey: string | null; now: Date },
): PeopleNamed[] {
  const shown = new Set(options.map((o) => o.candidate.contactId));
  const aboveNames = new Set(options.map((o) => nameKey(o.candidate.name)));
  const out: PeopleNamed[] = [];
  const done = new Set<string>();
  for (const name of meeting.attendeeNames) {
    const key = fullNameKey(name);
    if (!key || key === opts.viewerNameKey || done.has(key)) continue;
    done.add(key);
    const people = named.filter((r) => fullNameKey(r.name) === key && !shown.has(r.id)).map((r) => personTargetOf(r, opts.now));
    if (people.length) out.push({ name: name.trim().replace(/\s+/g, ' '), alsoAbove: aboveNames.has(key), people });
  }
  return out;
}

/** The viewer's suggested meetings, each with who it could be (worked out now, stored nowhere). */
export async function meetingsToReview(ctx: SessionContext, now = new Date()): Promise<ReviewMeeting[]> {
  if (!ctx.userId) return [];
  const userId = ctx.userId;
  const rows = await db.externalMeeting.findMany({
    where: { orgId: ctx.orgId, status: 'SUGGESTED', connection: { userId, status: { not: 'DISCONNECTED' } } },
    select: { id: true, provider: true, title: true, startAt: true, endAt: true, attendeeEmails: true, attendeeNames: true },
    orderBy: { startAt: 'desc' },
    take: 50,
  });
  if (!rows.length) return [];

  const [team, interviews] = await Promise.all([
    db.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true, email: true } }),
    db.interview.findMany({
      where: {
        orgId: ctx.orgId,
        state: { in: ['SCHEDULED', 'COMPLETED'] },
        opportunity: visibleOpportunityWhere(ctx),
        AND: [
          { OR: [{ panelists: { some: { id: userId } } }, { opportunity: { ownerId: userId } }] },
          {
            OR: rows.map((r) => ({
              startAt: { gte: new Date(r.startAt.getTime() - OPTION_WINDOW_MS), lte: new Date(r.startAt.getTime() + OPTION_WINDOW_MS) },
            })),
          },
        ],
      },
      select: {
        id: true,
        title: true,
        startAt: true,
        opportunityId: true,
        opportunity: { select: { posting: { select: { title: true } }, contact: { select: { id: true, name: true, emails: true } } } },
      },
      orderBy: { startAt: 'asc' },
      take: 500,
    }),
  ]);
  const viewer = team.find((u) => u.id === userId);
  const viewerNameKey = viewer ? fullNameKey(viewer.name) : null;
  const teamKeys = { names: new Set(team.map((u) => nameKey(u.name))), emails: new Set(team.map((u) => u.email.toLowerCase())) };

  const forOptions: InterviewForOptions[] = interviews.map((iv) => ({
    id: iv.id,
    opportunityId: iv.opportunityId,
    title: iv.title,
    startAt: iv.startAt,
    candidate: {
      contactId: iv.opportunity.contact.id,
      name: iv.opportunity.contact.name,
      email: iv.opportunity.contact.emails[0] ?? null,
      emails: iv.opportunity.contact.emails,
      postingTitle: iv.opportunity.posting?.title ?? null,
    },
  }));

  const nameKeys = [
    ...new Set(rows.flatMap((r) => r.attendeeNames.map(fullNameKey)).filter((k): k is string => k !== null && k !== viewerNameKey)),
  ].slice(0, 40);
  const named = await contactsNamed(ctx, nameKeys);

  return rows.map((r) => {
    const { options, preselect } = buildAttachOptions(r, forOptions);
    const peopleNamed = peopleNamedFor(r, options, named, { viewerNameKey, now });
    const everyone = [
      ...options.map((o) => ({ contactId: o.candidate.contactId, name: o.candidate.name })),
      ...peopleNamed.flatMap((g) => g.people.map((p) => ({ contactId: p.contactId, name: p.name }))),
    ];
    return {
      id: r.id,
      provider: r.provider,
      title: r.title,
      startAt: r.startAt.toISOString(),
      durationMins: r.endAt && r.endAt > r.startAt ? Math.round((r.endAt.getTime() - r.startAt.getTime()) / 60_000) : null,
      participants: participantsOf(r),
      options,
      preselect,
      sameName: sameNameWarnings(everyone),
      peopleNamed,
      quickPicks: quickPicks(r, teamKeys),
    };
  });
}
