import type { NormalizedMeeting } from '@/server/notetakers/parse';

/**
 * Which interview a notetaker meeting belongs to, if any. Pure: the sync
 * loads the interviews (the connecting user's, as a panelist or the
 * opportunity owner) and acts on the answer.
 *
 *  - No interview starts within 30 minutes of the meeting: not an interview.
 *    The sync drops it without storing anything about it.
 *  - One does, and a candidate email is among the attendees: attach. An
 *    email is the only evidence strong enough to act on alone.
 *  - One does, and the candidate's full name is among the attendees
 *    (notetakers that know names only, like Walkie): suggest it, naming
 *    that interview, with the reason 'name'. Two people can share a name,
 *    so a person confirms it on the review card.
 *  - Time lines up and nothing else: suggest the closest interview, with
 *    the reason 'time' (the notetaker may not know the candidate's address,
 *    or it's the recruiter's own meeting that happens to sit next to one).
 */

export const MATCH_TOLERANCE_MS = 30 * 60_000;

export type InterviewForMatch = {
  id: string;
  opportunityId: string;
  title: string;
  startAt: Date;
  candidateEmails: string[];
  /** The candidate's name; only a full name (two words or more) is matched. */
  candidateName?: string | null;
};

/** Why a meeting was put next to an interview. */
export type MatchReason = 'email' | 'name' | 'time';

export type MeetingMatch =
  | { kind: 'attach'; reason: 'email'; interview: InterviewForMatch }
  | { kind: 'suggest'; reason: 'name' | 'time'; interview: InterviewForMatch };

/** A name compared case- and whitespace-insensitively. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The name's key when it's a full name (two words or more), else null: a first name alone matches too many people. */
export function fullNameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = nameKey(name);
  return key.includes(' ') ? key : null;
}

/** The attendees' emails, lowercased. */
export function attendeeEmailSet(emails: (string | null | undefined)[]): Set<string> {
  return new Set(emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => Boolean(e)));
}

/** The attendees' full names, as keys. */
export function attendeeNameSet(names: (string | null | undefined)[]): Set<string> {
  return new Set(names.map(fullNameKey).filter((n): n is string => n !== null));
}

export function matchMeeting(
  meeting: Pick<NormalizedMeeting, 'startAt' | 'attendees'>,
  interviews: InterviewForMatch[],
  toleranceMs = MATCH_TOLERANCE_MS,
): MeetingMatch | null {
  const t = meeting.startAt.getTime();
  const near = interviews
    .map((iv) => ({ iv, gap: Math.abs(iv.startAt.getTime() - t) }))
    .filter((x) => x.gap <= toleranceMs)
    .sort((a, b) => a.gap - b.gap);
  if (!near.length) return null;
  const emails = attendeeEmailSet(meeting.attendees.map((a) => a.email));
  const byEmail = near.find((x) => x.iv.candidateEmails.some((e) => emails.has(e.trim().toLowerCase())));
  if (byEmail) return { kind: 'attach', reason: 'email', interview: byEmail.iv };
  const names = attendeeNameSet(meeting.attendees.map((a) => a.name));
  const byName = near.find((x) => {
    const key = fullNameKey(x.iv.candidateName);
    return key !== null && names.has(key);
  });
  if (byName) return { kind: 'suggest', reason: 'name', interview: byName.iv };
  return { kind: 'suggest', reason: 'time', interview: near[0].iv };
}

/** True when any interview starts within the tolerance of the meeting: worth asking for its attendees. */
export function nearAnInterview(meeting: Pick<NormalizedMeeting, 'startAt'>, interviews: InterviewForMatch[], toleranceMs = MATCH_TOLERANCE_MS) {
  const t = meeting.startAt.getTime();
  return interviews.some((iv) => Math.abs(iv.startAt.getTime() - t) <= toleranceMs);
}
