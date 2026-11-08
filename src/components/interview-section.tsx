'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition, useActionState } from 'react';
import { ArrowUpRight, CalendarDays, CalendarX, Check, Link2 } from 'lucide-react';
import {
  createSchedulingLinkAction,
  revokeSchedulingLinkAction,
  saveBookingUrlAction,
  scheduleInterviewAction,
  setInterviewStateAction,
  type BookingUrlFormState,
  type FormState,
  type SchedulingLinkFormState,
} from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  inputClass,
  badge,
  selectClass,
  surface,
  noAutofill,
} from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Badge, SectionHeader, Segmented, type Tone } from '@/components/ui/primitives';
import { SiteIcon } from '@/components/site-icon';
import { BOOKING_PROVIDER_LABEL, bookingLinkFor, bookingProvider } from '@/lib/booking';
import { TextSwap } from '@/components/ui/motion';
import { CopyButton } from '@/components/ui/copy-button';
import { LocalTime } from '@/components/local-time';
import { AttachRecordingButton } from '@/components/attach-recording';

// Panel pickers are pill chips: muted on the white form, ink when checked.
const panelChip =
  'selectable inline-flex h-8 cursor-pointer items-center rounded-full bg-muted px-3 text-sm text-ink hover:bg-recessed has-checked:is-selected has-focus-visible:ring-2 has-focus-visible:ring-line-strong';


type InterviewItem = {
  id: string;
  title: string;
  startAt: string;
  durationMins: number;
  location: string | null;
  state: 'SCHEDULED' | 'COMPLETED' | 'CANCELED';
  panelists: string[];
};

export type PlanStep = {
  id: string;
  title: string;
  durationMins: number;
  focusAreas: string[];
};

export type SchedulingLinkItem = {
  id: string;
  title: string;
  url: string;
  panel: string[];
  windowDays: number;
};

const STATE_TONES: Record<InterviewItem['state'], Tone | undefined> = {
  SCHEDULED: undefined,
  COMPLETED: 'positive',
  CANCELED: 'critical',
};

const STATE_LABELS: Record<InterviewItem['state'], string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
};

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Sydney',
];

export function InterviewSection({
  opportunityId,
  interviews,
  teammates,
  archived,
  planSteps = [],
  schedulingLinks = [],
  bookingUrl = null,
  candidate,
  recordings = false,
}: {
  opportunityId: string;
  /** The viewer's own booking page (Calendly, Cal.com, Google), if they've saved one. */
  bookingUrl?: string | null;
  /** The viewer has a notetaker connected: offer "Attach a recording". */
  recordings?: boolean;
  candidate: { name: string; email: string | null };
  interviews: InterviewItem[];
  teammates: { id: string; name: string }[];
  archived: boolean;
  planSteps?: PlanStep[];
  schedulingLinks?: SchedulingLinkItem[];
}) {
  const [open, setOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  // Someone who saved their own booking page most likely wants it.
  const [linkKind, setLinkKind] = useState<'builtin' | 'own'>(bookingUrl ? 'own' : 'builtin');
  const [prefill, setPrefill] = useState<PlanStep | null>(null);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    scheduleInterviewAction,
    undefined,
  );
  const [linkState, linkFormAction, linkPending] = useActionState<
    SchedulingLinkFormState,
    FormData
  >(createSchedulingLinkAction, undefined);
  const [, startTransition] = useTransition();

  return (
    <section>
      <SectionHeader
        title="Interviews"
        action={
          !archived && (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setLinkOpen((v) => !v);
                  setOpen(false);
                }}
                className={btnGhost}
              >
                <Link2 /> {linkOpen ? 'Cancel' : 'Self-schedule link'}
              </button>
              <button
                onClick={() => {
                  setOpen((v) => !v);
                  setLinkOpen(false);
                }}
                className={btnGhost}
              >
                <CalendarDays /> {open ? 'Cancel' : 'Schedule'}
              </button>
            </div>
          )
        }
      />

      {linkOpen ? (
        <div className={`${surface} mb-3 flex flex-col gap-4 p-5`}>
          <Segmented
            size="sm"
            value={linkKind}
            onChange={setLinkKind}
            items={[
              { value: 'builtin', label: 'Built-in link' },
              { value: 'own', label: 'Your booking page' },
            ]}
          />
          {linkKind === 'own' ? (
            <BookingPagePanel opportunityId={opportunityId} bookingUrl={bookingUrl} candidate={candidate} />
          ) : (
        <form action={linkFormAction} className="flex flex-col gap-3">
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <p className="text-xs text-ink-2">
            The candidate picks their own time from your open slots — booking creates the
            interview and sends the confirmation automatically.
          </p>
          <Field label="Title">
            <input {...noAutofill}
              name="title"
              required
              placeholder="Phone screen, Portfolio review…"
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Duration (min)">
              <input {...noAutofill}
                name="durationMins"
                type="number"
                defaultValue={30}
                min={15}
                step={15}
                className={inputClass}
              />
            </Field>
            <Field label="Open for (days)">
              <input {...noAutofill}
                name="windowDays"
                type="number"
                defaultValue={14}
                min={1}
                max={60}
                className={inputClass}
              />
            </Field>
            <Field label="Hours">
              <div className="flex items-center gap-1.5">
                <input {...noAutofill}
                  name="dayStartHour"
                  type="number"
                  defaultValue={9}
                  min={0}
                  max={23}
                  className={inputClass}
                  aria-label="Day start hour"
                />
                <span className="text-xs text-ink-2">to</span>
                <input {...noAutofill}
                  name="dayEndHour"
                  type="number"
                  defaultValue={17}
                  min={1}
                  max={24}
                  className={inputClass}
                  aria-label="Day end hour"
                />
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Timezone">
              <select name="timezone" defaultValue="America/New_York" className={selectClass}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Location / video link">
              <input {...noAutofill} name="location" placeholder="Zoom link, office…" className={inputClass} />
            </Field>
          </div>
          <Field label="Panel">
            <div className="flex flex-wrap gap-2">
              {teammates.map((t) => (
                <label key={t.id} className={panelChip}>
                  <input type="checkbox" name="panelistIds" value={t.id} className="sr-only" />
                  {t.name}
                </label>
              ))}
            </div>
          </Field>
          {linkState?.error ? <p className="text-sm text-critical">{linkState.error}</p> : null}
          {linkState?.url ? (
            <p className="text-sm">
              <span className="text-ink-2">Send this link to the candidate: </span>
              <code className="break-all rounded-field bg-recessed px-1.5 py-0.5 font-mono text-xs">
                {typeof window !== 'undefined' ? window.location.origin : ''}
                {linkState.url}
              </code>
            </p>
          ) : null}
          <div className="flex justify-end">
            <button type="submit" disabled={linkPending} className={btnPrimary}>
              {linkPending ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
          )}
        </div>
      ) : null}

      {schedulingLinks.length ? (
        <div className={`${surface} mb-3 p-5`}>
          <p className="mb-3 text-xs font-medium text-ink-2">Open scheduling links</p>
          <div className="flex flex-col gap-3">
            {schedulingLinks.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.title}</p>
                  <p className="truncate text-xs text-ink-2">
                    {l.panel.join(', ')} · open {l.windowDays} days
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <CopyButton text={() => `${window.location.origin}${l.url}`} label="Copy link" />
                  <button
                    onClick={() =>
                      startTransition(() => revokeSchedulingLinkAction(l.id, opportunityId))
                    }
                    className={buttonClass({ variant: 'ghost', size: 'xs' })}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {open ? (
        <form
          key={prefill?.id ?? 'blank'}
          action={formAction}
          className={`${surface} mb-3 flex flex-col gap-3 p-5`}
        >
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="focusAreas" value={prefill?.focusAreas.join('|') ?? ''} />
          {planSteps.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-ink-2">From plan:</span>
              {planSteps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setPrefill(step)}
                  aria-pressed={prefill?.id === step.id}
                  className={cn(
                    badge,
                    'selectable cursor-pointer',
                    prefill?.id === step.id ? 'is-selected' : 'hover:bg-recessed hover:text-ink',
                  )}
                >
                  {step.title}
                </button>
              ))}
            </div>
          ) : null}
          <Field label="Title">
            <input {...noAutofill}
              name="title"
              required
              defaultValue={prefill?.title ?? ''}
              placeholder="Phone screen, Portfolio review…"
              className={inputClass}
            />
          </Field>
          {prefill?.focusAreas.length ? (
            <p className="flex flex-wrap gap-1">
              {prefill.focusAreas.map((f) => (
                <span key={f} className={badge}>
                  {f}
                </span>
              ))}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date & time">
              <input {...noAutofill} name="startAt" type="datetime-local" required className={inputClass} />
            </Field>
            <Field label="Duration (min)">
              <input {...noAutofill}
                name="durationMins"
                type="number"
                defaultValue={prefill?.durationMins ?? 60}
                min={15}
                step={15}
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="Location / video link">
            <input {...noAutofill} name="location" placeholder="Zoom link, office…" className={inputClass} />
          </Field>
          <Field label="Panel">
            <div className="flex flex-wrap gap-2">
              {teammates.map((t) => (
                <label key={t.id} className={panelChip}>
                  <input type="checkbox" name="panelistIds" value={t.id} className="sr-only" />
                  {t.name}
                </label>
              ))}
            </div>
          </Field>
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Scheduling…' : 'Schedule interview'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {interviews.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {interviews.map((iv) => (
            <div key={iv.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    <Link href={`/interviews/${iv.id}`} className="hover:underline" title="Open interview kit">
                      {iv.title}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    <LocalTime date={iv.startAt} />{' '}
                    · {iv.durationMins} min
                    {iv.location ? ` · ${iv.location}` : ''}
                  </p>
                  {iv.panelists.length > 0 ? (
                    <p className="mt-1 text-xs text-ink-2">with {iv.panelists.join(', ')}</p>
                  ) : null}
                </div>
                <Badge tone={STATE_TONES[iv.state]}>{STATE_LABELS[iv.state]}</Badge>
              </div>
              {iv.state === 'SCHEDULED' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(() =>
                        setInterviewStateAction(iv.id, opportunityId, 'COMPLETED'),
                      )
                    }
                    className={buttonClass({ variant: 'tonal', size: 'sm' })}
                  >
                    <Check /> Mark completed
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(() => setInterviewStateAction(iv.id, opportunityId, 'CANCELED'))
                    }
                    className={buttonClass({ variant: 'tonal', size: 'sm' })}
                  >
                    <CalendarX /> Cancel interview
                  </button>
                  {recordings ? (
                    <AttachRecordingButton
                      interview={{ id: iv.id, title: iv.title, startAt: iv.startAt }}
                      candidateName={candidate.name}
                    />
                  ) : null}
                </div>
              ) : iv.state === 'COMPLETED' && recordings ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <AttachRecordingButton
                    interview={{ id: iv.id, title: iv.title, startAt: iv.startAt }}
                    candidateName={candidate.name}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">No interviews scheduled.</p>
      ) : null}
    </section>
  );
}

/**
 * The recruiter's own booking page, as the alternative to a built-in link.
 * First time, they paste it (saved to their account, so it's there for every
 * candidate); after that it's one click to copy. Calendly and Cal.com links
 * carry the candidate's name and email so the booking form is filled in.
 * Bookings made there don't come back into Orqestra, and the panel says so.
 */
function BookingPagePanel({
  opportunityId,
  bookingUrl,
  candidate,
}: {
  opportunityId: string;
  bookingUrl: string | null;
  candidate: { name: string; email: string | null };
}) {
  const [editing, setEditing] = useState(!bookingUrl);
  const [state, action, pending] = useActionState<BookingUrlFormState, FormData>(saveBookingUrlAction, undefined);
  useEffect(() => {
    if (state?.saved) setEditing(false);
  }, [state]);

  if (bookingUrl && !editing) {
    const provider = bookingProvider(bookingUrl);
    const link = bookingLinkFor(bookingUrl, candidate);
    const prefilled = provider === 'calendly' || provider === 'cal';
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-field bg-muted px-3 py-2.5">
          <SiteIcon url={bookingUrl} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{BOOKING_PROVIDER_LABEL[provider]}</p>
            <p className="truncate text-xs text-ink-2">{bookingUrl.replace(/^https?:\/\//, '')}</p>
          </div>
          <button type="button" onClick={() => setEditing(true)} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
            Change
          </button>
        </div>
        <p className="text-xs text-ink-2">
          {prefilled
            ? `The link fills in ${candidate.name.split(' ')[0]}’s name and email, so they only pick a time. `
            : ''}
          Bookings made there don’t come back into Orqestra on their own: once they book, add the interview
          with Schedule.
        </p>
        <div className="flex justify-end gap-2">
          <a href={link} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: 'tonal' })}>
            Open <ArrowUpRight />
          </a>
          <CopyButton text={link} label="Copy link" variant="primary" size="md" />
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <Field label="Your booking page">
        <input {...noAutofill}
          name="bookingUrl"
          defaultValue={bookingUrl ?? ''}
          placeholder="calendly.com/you/30min"
          autoFocus
          className={inputClass}
        />
      </Field>
      <p className="-mt-1 text-xs text-ink-2">
        Calendly, Cal.com, or a Google Calendar booking page. It’s saved to your account, so it’s here for every
        candidate. Clear it and save to remove it.
      </p>
      {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
      <div className="flex justify-end gap-2">
        {bookingUrl ? (
          <button type="button" onClick={() => setEditing(false)} className={btnGhost}>
            Cancel
          </button>
        ) : null}
        <button type="submit" disabled={pending} className={btnPrimary}>
          <TextSwap>{pending ? 'Saving…' : 'Save'}</TextSwap>
        </button>
      </div>
    </form>
  );
}
