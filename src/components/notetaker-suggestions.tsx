'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import {
  attachMeetingAction,
  dismissMeetingAction,
  searchAttachCandidatesAction,
} from '@/app/(app)/settings/notetaker-actions';
import type { AttachedTo } from '@/server/notetakers/binding';
import type { AttachOption, PersonTarget, ReviewMeeting, SameNameWarning } from '@/server/notetakers/review';
import { Field, fieldBareInput, fieldShellClass, noAutofill, surface } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { BusyLabel } from '@/components/imports/fields';
import { LocalTime } from '@/components/local-time';
import { ChoiceRow, RecordingSummary, useLocalFormat } from '@/components/notetaker-recording';
import { buttonClass } from '@/components/ui/button';
import { SuccessCheck } from '@/components/ui/motion';
import { Avatar } from '@/components/ui/orb';
import { Badge, Chip, SectionHeader, StatusDot } from '@/components/ui/primitives';

/**
 * "Transcripts to review" on the Interviews page: meetings a person's
 * notetaker recorded near one of their interviews without a candidate email
 * to confirm who it was with. Only they see these. Each card asks one
 * question, which person is this: the interviews around that time (with
 * why each is there), people with a participant's name, or anyone else they
 * can find. Attach fetches the transcript onto the choice; "Not an
 * interview" forgets the meeting.
 */

export type { ReviewMeeting } from '@/server/notetakers/review';

const REASON_LABEL: Record<AttachOption['reason'], string> = {
  email: 'Email in meeting',
  name: 'Name in meeting',
  time: 'Same time',
};

const PROFILE = 'profile';
const HOUR = 3_600_000;

type Done = { meeting: ReviewMeeting; attachedTo: AttachedTo | null; linked: boolean };

export function NotetakerSuggestions({ meetings }: { meetings: ReviewMeeting[] }) {
  // Attached cards stay as a confirmation after the page data drops them.
  const [done, setDone] = useState<Record<string, Done>>({});
  const live = new Set(meetings.map((m) => m.id));
  const rows = [...meetings, ...Object.values(done).filter((d) => !live.has(d.meeting.id)).map((d) => d.meeting)].sort(
    (a, b) => b.startAt.localeCompare(a.startAt),
  );
  if (!rows.length) return null;
  const waiting = meetings.some((m) => !done[m.id]);
  return (
    <section>
      <SectionHeader title="Transcripts to review" />
      <div className={`${surface} divide-y divide-line`}>
        {rows.map((m) =>
          done[m.id] ? (
            <Confirmation key={m.id} done={done[m.id]} />
          ) : (
            <ReviewCard key={m.id} meeting={m} onAttached={(d) => setDone((prev) => ({ ...prev, [m.id]: d }))} />
          ),
        )}
      </div>
      {waiting ? (
        <p className="mt-2 text-xs text-ink-2">
          Your notetaker recorded these near your interviews but couldn&apos;t confirm who they were with. Only you see these.
        </p>
      ) : null}
    </section>
  );
}

function Confirmation({ done }: { done: Done }) {
  const to = done.attachedTo;
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <SuccessCheck size={20} className="shrink-0" />
      <p className="min-w-0 flex-1 text-sm text-ink">
        {to ? (
          <>
            {done.linked ? 'A teammate had already attached this recording to ' : 'Attached to '}
            <Link href={`/candidates/${to.opportunityId}`} className="font-medium underline-offset-2 hover:underline">
              {to.contactName}
            </Link>
            {to.interviewTitle ? <span className="text-ink-2"> · {to.interviewTitle}</span> : <span className="text-ink-2"> · profile</span>}
          </>
        ) : (
          'Attached.'
        )}
        <span className="block truncate text-xs text-ink-2">{done.meeting.title || 'Untitled meeting'}</span>
      </p>
      {to ? (
        <Link href={`/candidates/${to.opportunityId}`} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          Open candidate
        </Link>
      ) : null}
    </div>
  );
}

const COUNT_WORDS = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

export function SameNameNotes({ warnings }: { warnings: SameNameWarning[] }) {
  if (!warnings.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {warnings.map((w) => (
        <p key={w.name.toLowerCase()} className="flex items-start gap-2 text-xs text-ink-2">
          <StatusDot tone="caution" className="mt-[5px]" />
          {COUNT_WORDS[w.count] ?? w.count} candidates named {w.name} — check the email and role.
        </p>
      ))}
    </div>
  );
}

/** Name and email on one line, role and an interview on the next: enough to tell two people with one name apart. */
function PersonLines({ person }: { person: PersonTarget }) {
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-ink">{person.name}</span>
        <span className="truncate text-xs text-ink-2">{person.email ?? 'No email on file'}</span>
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-2">
        {person.role ?? 'No role'}
        {person.moreRoles ? ` +${person.moreRoles}` : ''}
        {' · '}
        {person.interview ? (
          <>
            {person.interview.when === 'next' ? 'Next' : 'Last'}: {person.interview.title},{' '}
            <LocalTime date={person.interview.startAt} options={{ month: 'short', day: 'numeric' }} />
          </>
        ) : (
          'No interviews'
        )}
      </p>
    </div>
  );
}

type Target = { opportunityId: string; interviewId: string };

/** The interview nearest the meeting (within 12 hours), else the profile of their latest open application. */
function defaultTarget(person: PersonTarget, meetingStart: string): Target {
  const t = new Date(meetingStart).getTime();
  let best: { target: Target; gap: number } | null = null;
  for (const app of person.applications) {
    for (const iv of app.interviews) {
      const gap = Math.abs(new Date(iv.startAt).getTime() - t);
      if (gap <= 12 * HOUR && (!best || gap < best.gap)) best = { target: { opportunityId: app.opportunityId, interviewId: iv.id }, gap };
    }
  }
  if (best) return best.target;
  const app = person.applications.find((a) => !a.archived) ?? person.applications[0];
  return { opportunityId: app?.opportunityId ?? '', interviewId: '' };
}

/** Which of the person's applications, and which interview or none. */
function TargetPicker({ person, value, onChange }: { person: PersonTarget; value: Target; onChange: (t: Target) => void }) {
  const fmt = useLocalFormat();
  const app = person.applications.find((a) => a.opportunityId === value.opportunityId) ?? person.applications[0];
  if (!app) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {person.applications.length > 1 ? (
        <Field label="Application">
          <FormSelect
            value={app.opportunityId}
            onChange={(opportunityId) => onChange({ opportunityId, interviewId: '' })}
            options={person.applications.map((a) => ({
              value: a.opportunityId,
              label: `${a.postingTitle ?? 'No role'}${a.archived ? ' (archived)' : ''}`,
            }))}
          />
        </Field>
      ) : null}
      <Field label="Interview">
        <FormSelect
          value={value.interviewId || PROFILE}
          onChange={(v) => onChange({ opportunityId: app.opportunityId, interviewId: v === PROFILE ? '' : v })}
          options={[
            ...app.interviews.map((iv) => ({ value: iv.id, label: `${iv.title} · ${fmt(iv.startAt)}` })),
            { value: PROFILE, label: 'Their profile, without an interview' },
          ]}
        />
      </Field>
    </div>
  );
}

function ReviewCard({ meeting, onAttached }: { meeting: ReviewMeeting; onAttached: (d: Done) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'attach' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(meeting.preselect ? `iv:${meeting.preselect}` : null);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [other, setOther] = useState<PersonTarget | null>(null);
  const radio = `attach-${meeting.id}`;

  const people = new Map(meeting.peopleNamed.flatMap((g) => g.people.map((p) => [p.contactId, p] as const)));
  const targetFor = (p: PersonTarget) => targets[p.contactId] ?? defaultTarget(p, meeting.startAt);
  const setTarget = (p: PersonTarget, t: Target) => setTargets((prev) => ({ ...prev, [p.contactId]: t }));

  const chosen = (): { interviewId: string | null; opportunityId: string | null } | null => {
    if (!choice) return null;
    if (choice.startsWith('iv:')) {
      const o = meeting.options.find((x) => `iv:${x.interviewId}` === choice);
      return o ? { interviewId: o.interviewId, opportunityId: o.opportunityId } : null;
    }
    const person = choice.startsWith('p:') ? people.get(choice.slice(2)) : choice === 'other' ? other : null;
    if (!person) return null;
    const t = targetFor(person);
    return t.opportunityId ? { interviewId: t.interviewId || null, opportunityId: t.opportunityId } : null;
  };
  const target = chosen();

  const attach = () => {
    if (!target) return;
    setError(null);
    setBusy('attach');
    startTransition(async () => {
      const result = await attachMeetingAction(meeting.id, target);
      setBusy(null);
      if ('error' in result) setError(result.error);
      else onAttached({ meeting, attachedTo: result.attachedTo, linked: result.linked });
    });
  };
  const dismiss = () => {
    setError(null);
    setBusy('dismiss');
    startTransition(async () => {
      await dismissMeetingAction(meeting.id);
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <div className="px-4 py-4">
      <RecordingSummary
        provider={meeting.provider}
        title={meeting.title}
        startAt={meeting.startAt}
        durationMins={meeting.durationMins}
        participants={meeting.participants}
      />

      <div className="mt-4 flex flex-col gap-2 sm:pl-8">
        <p className="text-xs font-medium text-ink-2">Attach to</p>
        <SameNameNotes warnings={meeting.sameName} />

        {meeting.options.length ? (
          <div role="radiogroup" aria-label="Interviews around that time" className="flex flex-col gap-1">
            {meeting.options.map((o) => (
              <ChoiceRow key={o.interviewId} name={radio} value={o.interviewId} checked={choice === `iv:${o.interviewId}`} onSelect={() => setChoice(`iv:${o.interviewId}`)}>
                <div className="flex items-start gap-3">
                  <Avatar name={o.candidate.name} seed={o.candidate.contactId} size={28} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium text-ink">{o.candidate.name}</span>
                      <span className="truncate text-xs text-ink-2">{o.candidate.email ?? 'No email on file'}</span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-2">
                      {o.candidate.postingTitle ?? 'No role'} · {o.interviewTitle} ·{' '}
                      <span className="tabular-nums">
                        <LocalTime date={o.startAt} options={{ hour: 'numeric', minute: '2-digit' }} />
                      </span>
                    </p>
                    <Badge onCanvas={choice !== `iv:${o.interviewId}`} className="mt-1.5 sm:hidden">
                      {REASON_LABEL[o.reason]}
                    </Badge>
                  </div>
                  {/* On a muted (unselected) row the chip takes the surface fill, so it still reads. */}
                  <Badge onCanvas={choice !== `iv:${o.interviewId}`} className="hidden sm:inline-flex">
                    {REASON_LABEL[o.reason]}
                  </Badge>
                </div>
              </ChoiceRow>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-2">None of your interviews are within two hours of this meeting.</p>
        )}

        {meeting.peopleNamed.map((group) => (
          <div key={group.name.toLowerCase()} className="mt-2 flex flex-col gap-2">
            <p className="text-xs font-medium text-ink-2">
              {group.alsoAbove ? 'Other people' : 'People'} named {group.name}
            </p>
            <div role="radiogroup" aria-label={`People named ${group.name}`} className="flex flex-col gap-1">
              {group.people.map((p) => (
                <div key={p.contactId} className="flex flex-col gap-2">
                  <ChoiceRow name={radio} value={p.contactId} checked={choice === `p:${p.contactId}`} onSelect={() => setChoice(`p:${p.contactId}`)}>
                    <div className="flex items-start gap-3">
                      <Avatar name={p.name} seed={p.contactId} size={28} className="shrink-0" />
                      <PersonLines person={p} />
                    </div>
                  </ChoiceRow>
                  {choice === `p:${p.contactId}` ? (
                    <div className="pb-1 pl-7">
                      <TargetPicker person={p} value={targetFor(p)} onChange={(t) => setTarget(p, t)} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-2 flex flex-col gap-2">
          <ChoiceRow name={radio} value="other" checked={choice === 'other'} onSelect={() => setChoice('other')}>
            <p className="text-sm text-ink">Someone else…</p>
          </ChoiceRow>
          {choice === 'other' ? (
            <div className="pb-1 pl-7">
              <SomeoneElse
                quickPicks={meeting.quickPicks}
                picked={other}
                onPick={setOther}
                target={other ? targetFor(other) : null}
                onTarget={(t) => other && setTarget(other, t)}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end sm:pl-8">
        {error ? <p className="text-xs text-critical sm:mr-auto">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={pending} onClick={dismiss} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            <BusyLabel busy={busy === 'dismiss'}>Not an interview</BusyLabel>
          </button>
          <button type="button" disabled={pending || !target} onClick={attach} className={buttonClass({ variant: 'primary', size: 'sm' })}>
            <BusyLabel busy={busy === 'attach'}>Attach</BusyLabel>
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Someone else…": search the candidates the viewer can see, with the meeting's outside participants as quick picks. */
function SomeoneElse({
  quickPicks,
  picked,
  onPick,
  target,
  onTarget,
}: {
  quickPicks: string[];
  picked: PersonTarget | null;
  onPick: (p: PersonTarget | null) => void;
  target: Target | null;
  onTarget: (t: Target) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonTarget[] | null>(null);
  const [searching, setSearching] = useState(false);
  const latest = useRef('');

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = setTimeout(async () => {
      const found = await searchAttachCandidatesAction(q).catch(() => []);
      if (latest.current !== q) return;
      setResults(found);
      setSearching(false);
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  if (picked && target) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3 rounded-field bg-muted px-3 py-2.5">
          <Avatar name={picked.name} seed={picked.contactId} size={28} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <PersonLines person={picked} />
          </div>
          <button type="button" onClick={() => onPick(null)} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
            Change
          </button>
        </div>
        <TargetPicker person={picked} value={target} onChange={onTarget} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className={fieldShellClass}>
        <Search size={16} className="ml-3 shrink-0 text-ink-3" aria-hidden />
        <input
          {...noAutofill}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search candidates by name or email"
          aria-label="Search candidates by name or email"
          className={`${fieldBareInput} [&::-webkit-search-cancel-button]:appearance-none`}
          autoFocus
        />
      </div>
      {quickPicks.length ? (
        <div className="flex flex-wrap gap-1.5">
          {quickPicks.map((p) => (
            <Chip key={p} onSurface selected={query.trim().toLowerCase() === p.toLowerCase()} onClick={() => setQuery(p)}>
              {p}
            </Chip>
          ))}
        </div>
      ) : null}
      {searching && !results ? <p className="text-xs text-ink-2">Searching…</p> : null}
      {results ? (
        results.length ? (
          <div className="flex flex-col gap-1">
            {results.map((p) => (
              <button
                key={p.contactId}
                type="button"
                onClick={() => onPick(p)}
                className="flex cursor-pointer items-start gap-3 rounded-field bg-muted px-3 py-2.5 text-left transition-colors duration-[120ms] hover:bg-recessed"
              >
                <Avatar name={p.name} seed={p.contactId} size={28} className="shrink-0" />
                <PersonLines person={p} />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-2">No candidates match “{query.trim()}”.</p>
        )
      ) : null}
    </div>
  );
}
