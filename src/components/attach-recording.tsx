'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { FileAudio, X } from 'lucide-react';
import { attachRecordingAction, recordingsNearInterviewAction } from '@/app/(app)/settings/notetaker-actions';
import type { PickerMeeting, PickerResult } from '@/server/notetakers/picker';
import { BusyLabel } from '@/components/imports/fields';
import { LocalTime } from '@/components/local-time';
import { ChoiceRow, ProviderIcon, RecordingSummary } from '@/components/notetaker-recording';
import { buttonClass } from '@/components/ui/button';
import { SuccessCheck } from '@/components/ui/motion';
import { Badge, StatusDot } from '@/components/ui/primitives';

/**
 * "Attach a recording" on one of a candidate's interviews: the viewer's own
 * meetings from each notetaker they've connected, 12 hours either side of
 * the interview, read live when the dialog opens. Nothing is kept unless
 * they attach one. Recordings with this candidate's name or email among the
 * participants are marked and listed first; none is picked for them.
 */

export function AttachRecordingButton({
  interview,
  candidateName,
  size = 'sm',
}: {
  interview: { id: string; title: string; startAt: string };
  candidateName: string;
  size?: 'xs' | 'sm';
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={buttonClass({ variant: 'tonal', size })}>
          <FileAudio /> Attach a recording
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-[300] bg-ink/10" />
        <Dialog.Content className="dialog-animate fixed left-1/2 top-[max(16px,10vh)] z-[300] flex max-h-[min(720px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-dialog bg-surface shadow-float outline-none">
          <Dialog.Close
            aria-label="Close"
            className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'absolute right-3 top-3' })}
          >
            <X />
          </Dialog.Close>
          {open ? <Picker interview={interview} candidateName={candidateName} onClose={() => setOpen(false)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Picker({
  interview,
  candidateName,
  onClose,
}: {
  interview: { id: string; title: string; startAt: string };
  candidateName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<PickerResult | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [pending, startTransition] = useTransition();

  // One look per opening, even when an effect runs twice (Strict Mode): each
  // asks every notetaker, and a second run would find the first holding its lock.
  const request = useRef<Promise<PickerResult> | null>(null);
  useEffect(() => {
    let live = true;
    request.current ??= recordingsNearInterviewAction(interview.id).catch(
      (): PickerResult => ({ ok: false, error: "Couldn't reach your notetakers. Try again." }),
    );
    request.current.then((result) => live && setData(result));
    return () => {
      live = false;
    };
  }, [interview.id]);

  const meetings: PickerMeeting[] = data?.ok ? data.groups.flatMap((g) => g.meetings) : [];
  const choice = meetings.find((m) => m.token === picked) ?? null;

  const attach = () => {
    if (!choice) return;
    setError(null);
    startTransition(async () => {
      const result = await attachRecordingAction(interview.id, choice.token);
      if ('error' in result) setError(result.error);
      else {
        setAttached(true);
        router.refresh();
      }
    });
  };

  if (attached && choice) {
    return (
      <div className="flex flex-col items-start gap-4 p-6">
        <SuccessCheck size={24} />
        <div>
          <Dialog.Title className="text-md font-medium text-ink">Attached to {interview.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink-2">
            {choice.title || 'The recording'} is on {candidateName}&apos;s profile now, with this interview.
          </Dialog.Description>
        </div>
        <div className="flex w-full justify-end">
          <button type="button" onClick={onClose} className={buttonClass({ variant: 'primary' })}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="px-6 pb-4 pt-6 pr-14">
        <Dialog.Title className="text-md font-medium text-ink">
          Recordings near <LocalTime date={interview.startAt} />
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-ink-2">
          {interview.title} with {candidateName}. From your notetakers, 12 hours either side. Nothing is saved unless you attach one.
        </Dialog.Description>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">
        {!data ? (
          <p role="status" className="py-6 text-sm text-ink-2">
            Looking for recordings…
          </p>
        ) : !data.ok ? (
          <p className="flex items-center gap-2 py-6 text-sm text-ink-2">
            <StatusDot tone="critical" /> {data.error}
          </p>
        ) : !data.connected ? (
          <div className="py-6">
            <p className="text-sm text-ink">No notetaker connected</p>
            <p className="mt-1 text-sm text-ink-2">
              Connect Walkie, Fireflies, Fathom or another notetaker in{' '}
              <Link href="/settings?section=integrations#notetakers" className="text-ink underline-offset-2 hover:underline">
                Settings → Integrations
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5 pb-2">
            {data.groups.map((g) => (
              <section key={g.provider} className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
                  <ProviderIcon provider={g.provider} size={14} /> {g.name}
                </p>
                {g.error ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
                    <StatusDot tone="critical" /> {g.error}
                    {g.reconnect ? (
                      <Link href="/settings?section=integrations#notetakers" className="text-ink underline-offset-2 hover:underline">
                        Reconnect
                      </Link>
                    ) : null}
                  </p>
                ) : !g.meetings.length ? (
                  <p className="text-sm text-ink-2">No recordings within 12 hours in {g.name}</p>
                ) : (
                  <div role="radiogroup" aria-label={`Recordings in ${g.name}`} className="flex flex-col gap-1">
                    {g.meetings.map((m) => (
                      <ChoiceRow
                        key={m.token}
                        name={`recording-${interview.id}`}
                        value={m.externalId}
                        checked={picked === m.token}
                        disabled={Boolean(m.attached)}
                        onSelect={() => setPicked(m.token)}
                      >
                        <RecordingSummary
                          provider={g.provider}
                          title={m.title}
                          startAt={m.startAt}
                          durationMins={m.durationMins}
                          participants={m.participants}
                          showIcon={false}
                          showProvider={false}
                          after={m.suggested && !m.attached ? <Badge tone="info">Suggested</Badge> : null}
                        />
                        {m.attached ? (
                          <p className="mt-1 text-xs text-ink-2">
                            {m.attached.here
                              ? 'Already attached to this interview'
                              : m.attached.to
                                ? `Already attached to ${m.attached.to.contactName}${m.attached.to.interviewTitle ? ` · ${m.attached.to.interviewTitle}` : ''}`
                                : 'Already attached once; that transcript was deleted'}
                          </p>
                        ) : m.suggested ? (
                          <p className="mt-1 text-xs text-ink-2">{m.suggested.text}</p>
                        ) : null}
                      </ChoiceRow>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-line px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
        {error ? <p className="text-xs text-critical sm:mr-auto">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Dialog.Close asChild>
            <button type="button" className={buttonClass({ variant: 'ghost' })}>
              Cancel
            </button>
          </Dialog.Close>
          <button type="button" disabled={!choice || pending} onClick={attach} className={buttonClass({ variant: 'primary' })}>
            <BusyLabel busy={pending}>Attach</BusyLabel>
          </button>
        </div>
      </div>
    </>
  );
}
