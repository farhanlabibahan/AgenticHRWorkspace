import { describe, expect, it } from 'vitest';
import { suggestionFor } from '@/server/notetakers/picker';
import {
  buildAttachOptions,
  OPTION_WINDOW_MS,
  participantsOf,
  peopleNamedFor,
  quickPicks,
  reasonFor,
  sameNameWarnings,
  type InterviewForOptions,
} from '@/server/notetakers/review';

/**
 * The review card's choices, worked out from a meeting's participants and
 * the viewer's interviews (src/server/notetakers/review.ts): which
 * interviews are offered and why, which is preselected, and when to warn
 * that two candidates share a name. Pure; the database side is in
 * tests/notetaker-binding.test.ts.
 */

const T = new Date('2026-09-22T15:00:00Z');
const MIN = 60_000;

let n = 0;
function iv(
  minutes: number,
  candidate: { name: string; emails?: string[]; contactId?: string; postingTitle?: string | null },
  id = `iv-${++n}`,
): InterviewForOptions {
  return {
    id,
    opportunityId: `opp-${id}`,
    title: 'Onsite',
    startAt: new Date(T.getTime() + minutes * MIN),
    candidate: {
      contactId: candidate.contactId ?? `c-${candidate.name}`,
      name: candidate.name,
      email: candidate.emails?.[0] ?? null,
      emails: candidate.emails ?? [],
      postingTitle: candidate.postingTitle ?? 'Engineer',
    },
  };
}

const meeting = (over: Partial<{ attendeeEmails: string[]; attendeeNames: string[] }> = {}) => ({
  startAt: T,
  attendeeEmails: over.attendeeEmails ?? [],
  attendeeNames: over.attendeeNames ?? [],
});

describe('the interviews offered on a review card', () => {
  it('offers every interview within two hours either side, and none further', () => {
    const inside = [iv(-120, { name: 'A One' }), iv(0, { name: 'B Two' }), iv(119, { name: 'C Three' })];
    const outside = [iv(-121, { name: 'D Four' }), iv(180, { name: 'E Five' })];
    const { options } = buildAttachOptions(meeting(), [...outside, ...inside]);
    expect(options.map((o) => o.candidate.name).sort()).toEqual(['A One', 'B Two', 'C Three']);
    expect(OPTION_WINDOW_MS).toBe(120 * MIN);
  });

  it('says why each is there: an email in the meeting, the full name in it, or only the time', () => {
    const m = meeting({ attendeeEmails: ['Priya@Example.com'], attendeeNames: ['Adam Perlis', '  jordan   LEE '] });
    expect(reasonFor(m, { name: 'Priya Nair', emails: ['priya@example.com'] })).toBe('email');
    expect(reasonFor(m, { name: 'Jordan Lee', emails: ['jordan@example.com'] })).toBe('name');
    expect(reasonFor(m, { name: 'Sam Diaz', emails: [] })).toBe('time');
    // A first name alone matches too many people to count.
    expect(reasonFor(meeting({ attendeeNames: ['Jordan'] }), { name: 'Jordan', emails: [] })).toBe('time');
  });

  it('puts the strongest first and preselects it: email, then name, then the closest in time', () => {
    const byTime = iv(5, { name: 'Close Call' });
    const byTimeFar = iv(-90, { name: 'Far Away' });
    const byName = iv(100, { name: 'Jordan Lee' });
    const byEmail = iv(-110, { name: 'Priya Nair', emails: ['priya@example.com'] });
    const m = meeting({ attendeeEmails: ['priya@example.com'], attendeeNames: ['Jordan Lee'] });
    const { options, preselect } = buildAttachOptions(m, [byTimeFar, byName, byTime, byEmail]);
    expect(options.map((o) => [o.candidate.name, o.reason])).toEqual([
      ['Priya Nair', 'email'],
      ['Jordan Lee', 'name'],
      ['Close Call', 'time'],
      ['Far Away', 'time'],
    ]);
    expect(preselect).toBe(byEmail.id);

    // Without an email, the name leads; without either, the closest.
    expect(buildAttachOptions(meeting({ attendeeNames: ['Jordan Lee'] }), [byTime, byName]).preselect).toBe(byName.id);
    expect(buildAttachOptions(meeting(), [byTimeFar, byTime]).preselect).toBe(byTime.id);
    expect(buildAttachOptions(meeting(), [iv(300, { name: 'Tomorrow Maybe' })])).toEqual({ options: [], preselect: null });
  });

  it('carries what tells two people apart: email, role, interview and its time', () => {
    const one = iv(10, { name: 'Priya Nair', emails: ['priya@acme.test'], postingTitle: 'Designer', contactId: 'c1' });
    const [option] = buildAttachOptions(meeting(), [one]).options;
    expect(option).toEqual({
      interviewId: one.id,
      opportunityId: one.opportunityId,
      interviewTitle: 'Onsite',
      startAt: one.startAt.toISOString(),
      reason: 'time',
      candidate: { contactId: 'c1', name: 'Priya Nair', email: 'priya@acme.test', postingTitle: 'Designer' },
    });
  });
});

describe('the same-name warning', () => {
  it('warns when two different candidates share a name, ignoring case and spacing', () => {
    expect(
      sameNameWarnings([
        { contactId: 'c1', name: 'Priya Nair' },
        { contactId: 'c2', name: '  priya   NAIR' },
        { contactId: 'c3', name: 'Jordan Lee' },
      ]),
    ).toEqual([{ name: 'Priya Nair', count: 2 }]);
  });

  it('does not warn about one person with two interviews', () => {
    expect(
      sameNameWarnings([
        { contactId: 'c1', name: 'Priya Nair' },
        { contactId: 'c1', name: 'Priya Nair' },
      ]),
    ).toEqual([]);
  });

  it('counts three and more', () => {
    const three = ['c1', 'c2', 'c3'].map((contactId) => ({ contactId, name: 'Sam Diaz' }));
    expect(sameNameWarnings(three)).toEqual([{ name: 'Sam Diaz', count: 3 }]);
  });
});

describe('people named like a participant', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const person = (id: string, name: string, email: string, role: string, interviews: { title: string; at: string }[] = []) => ({
    id,
    name,
    emails: [email],
    opportunities: [
      {
        id: `opp-${id}`,
        status: 'ACTIVE' as const,
        posting: { title: role },
        interviews: interviews.map((x, i) => ({ id: `${id}-iv${i}`, title: x.title, startAt: new Date(x.at) })),
      },
    ],
  });

  it('groups candidates by the participant’s full name, leaving out those already offered and the viewer', () => {
    const offered = buildAttachOptions(meeting({ attendeeNames: ['Priya Nair'] }), [
      iv(10, { name: 'Priya Nair', contactId: 'p1', emails: ['priya@acme.test'] }),
    ]).options;
    const named = [
      person('p1', 'Priya Nair', 'priya@acme.test', 'Designer'),
      person('p2', 'Priya  Nair', 'pnair@gmail.test', 'Engineer', [
        { title: 'Screen', at: '2026-09-20T10:00:00Z' },
        { title: 'Onsite', at: '2026-09-30T10:00:00Z' },
      ]),
      person('a1', 'Adam Perlis', 'adam@candidate.test', 'Sales'),
    ];
    const groups = peopleNamedFor({ attendeeNames: ['Priya Nair', 'Adam Perlis', 'Sam'] }, offered, named, { viewerNameKey: 'adam perlis', now });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'Priya Nair', alsoAbove: true });
    expect(groups[0].people).toEqual([
      expect.objectContaining({
        contactId: 'p2',
        email: 'pnair@gmail.test',
        role: 'Engineer',
        interview: { when: 'next', title: 'Onsite', startAt: '2026-09-30T10:00:00.000Z' },
      }),
    ]);
    expect(groups[0].people[0].applications[0].interviews.map((i) => i.title)).toEqual(['Screen', 'Onsite']);
  });
});

describe('participants and quick picks', () => {
  it('shows names when the notetaker knows them, else emails', () => {
    expect(participantsOf({ attendeeNames: ['Priya Nair'], attendeeEmails: ['x@y.test'] })).toEqual(['Priya Nair']);
    expect(participantsOf({ attendeeNames: [], attendeeEmails: ['x@y.test'] })).toEqual(['x@y.test']);
  });

  it('offers the participants who are not on the team, the viewer included', () => {
    const team = { names: new Set(['adam perlis', 'sam recruiter']), emails: new Set(['adam@acme.test']) };
    expect(quickPicks({ attendeeNames: ['Adam  Perlis', 'Priya Nair', 'Sam Recruiter', 'Jo'], attendeeEmails: [] }, team)).toEqual(['Priya Nair', 'Jo']);
    expect(quickPicks({ attendeeNames: [], attendeeEmails: ['adam@acme.test', 'Priya@Example.com'] }, team)).toEqual(['priya@example.com']);
  });
});

describe('the candidate-side "Suggested" mark', () => {
  const candidate = { name: 'Priya Nair', emails: ['priya@example.com'] };
  it('says why: an email that was invited, or the full name that was there', () => {
    expect(suggestionFor({ attendees: [{ email: 'PRIYA@example.com' }] }, candidate)).toEqual({ reason: 'email', text: 'priya@example.com was invited' });
    expect(suggestionFor({ attendees: [{ name: 'priya  nair' }] }, candidate)).toEqual({ reason: 'name', text: 'Priya Nair was in this meeting' });
    expect(suggestionFor({ attendees: [{ name: 'Priya' }, { email: 'other@example.com' }] }, candidate)).toBeNull();
  });
});
