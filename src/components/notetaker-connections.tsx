'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  connectNotetakerAction,
  connectNotetakerKeyAction,
  disconnectNotetakerAction,
} from '@/app/(app)/settings/notetaker-actions';
import { NOTETAKER_PROVIDERS, notetakerProvider, type NotetakerProvider } from '@/lib/notetaker-providers';
import { inputClass, noAutofill } from '@/components/form-controls';
import { BusyLabel } from '@/components/imports/fields';
import { SiteIcon } from '@/components/site-icon';
import { buttonClass } from '@/components/ui/button';
import { StatusDot, type Tone } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Settings → Integrations → Meeting notetakers. Each person connects their
 * own notetaker (it only sees their meetings), by signing in or, for
 * Fireflies and Metaview, with a personal API key. The key lives only in
 * this form's state until it's sent, and is cleared once saved.
 */

export type NotetakerConnection = {
  provider: string;
  status: 'PENDING' | 'ACTIVE' | 'NEEDS_RECONNECT' | 'ERROR' | 'DISCONNECTED';
  authType: 'OAUTH' | 'API_KEY';
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type NotetakerOverviewRow = { provider: string; people: { name: string; status: NotetakerConnection['status'] }[] };

export type NotetakerNotice = { result: string; provider: string | null } | null;

function relative(iso: string, now: number): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(diff) < 1) return 'just now';
  if (Math.abs(diff) < 60) return rtf.format(diff, 'minute');
  if (Math.abs(diff) < 60 * 24) return rtf.format(Math.round(diff / 60), 'hour');
  return rtf.format(Math.round(diff / (60 * 24)), 'day');
}

function noticeText(notice: NonNullable<NotetakerNotice>): { text: string; tone: Tone } | null {
  const name = notice.provider ? (notetakerProvider(notice.provider)?.name ?? 'The notetaker') : 'The notetaker';
  switch (notice.result) {
    case 'connected':
      return { text: `${name} is connected. Transcripts from your interviews will start to appear within 10 minutes.`, tone: 'positive' };
    case 'cancelled':
      return { text: `Signing in to ${name} was cancelled.`, tone: 'neutral' };
    case 'failed':
      return { text: `${name} didn't finish connecting. Try again.`, tone: 'critical' };
    case 'invalid':
      return { text: 'That sign-in had expired or was already used. Start again from here.', tone: 'caution' };
    default:
      return null;
  }
}

function statusLine(c: NotetakerConnection | undefined, now: number | null): { text: string; tone: Tone | null } {
  if (!c || c.status === 'DISCONNECTED') return { text: 'Not connected', tone: null };
  if (c.status === 'PENDING') return { text: c.lastError ?? 'Sign-in not finished', tone: null };
  if (c.status === 'NEEDS_RECONNECT') return { text: c.lastError ?? 'Needs reconnecting', tone: 'critical' };
  if (c.status === 'ERROR') return { text: c.lastError ?? 'The last sync failed', tone: 'caution' };
  const how = c.authType === 'API_KEY' ? 'Connected with an API key' : 'Connected';
  if (!c.lastSyncedAt) return { text: `${how} · first sync within 10 minutes`, tone: 'positive' };
  return { text: `${how} · checked ${now === null ? 'recently' : relative(c.lastSyncedAt, now)}`, tone: 'positive' };
}

export function NotetakerConnections({
  connections,
  overview,
  notice,
  demo,
  suggestedCount,
}: {
  connections: NotetakerConnection[];
  /** Admins only: who in the org is connected. */
  overview: NotetakerOverviewRow[] | null;
  notice: NotetakerNotice;
  demo: boolean;
  suggestedCount: number;
}) {
  // Relative times render after mount, so server and client HTML agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const shown = notice ? noticeText(notice) : null;

  return (
    <div className="flex flex-col divide-y divide-line">
      <div className="px-4 py-4">
        <p className="max-w-prose text-sm text-ink-2">
          Connect the notetaker you record interviews with. Every 10 minutes Source looks for meetings that line up with
          interviews you&apos;re on and attaches their transcripts. Other meetings are skipped, and nothing about them is
          kept.
        </p>
        {shown ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-ink">
            <StatusDot tone={shown.tone} />
            {shown.text}
          </p>
        ) : null}
        {demo ? (
          <p className="mt-3 text-sm text-ink-2">Notetakers can&apos;t be connected in the demo workspace.</p>
        ) : null}
      </div>

      {NOTETAKER_PROVIDERS.map((p) => (
        <ProviderRow key={p.id} meta={p} connection={connections.find((c) => c.provider === p.id)} now={now} demo={demo} />
      ))}

      {suggestedCount ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-ink">
            {suggestedCount === 1 ? '1 meeting' : `${suggestedCount} meetings`} to review
          </p>
          <Link href="/interviews" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Review on Interviews
          </Link>
        </div>
      ) : null}

      {overview ? (
        <div className="px-4 py-4">
          <p className="text-sm font-medium text-ink">In your organization</p>
          {overview.length ? (
            <dl className="mt-2 flex flex-col gap-1.5">
              {overview.map((row) => (
                <div key={row.provider} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                  <dt className="w-24 shrink-0 text-ink-2">{notetakerProvider(row.provider)?.name ?? row.provider}</dt>
                  <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-ink">
                    {row.people.map((person, i) => (
                      <span
                        key={`${person.name}-${i}`}
                        className="inline-flex items-center gap-1.5"
                        title={
                          person.status === 'NEEDS_RECONNECT'
                            ? 'Needs to connect again'
                            : person.status === 'ERROR'
                              ? 'The last sync failed'
                              : 'Connected'
                        }
                      >
                        {person.status === 'ACTIVE' ? null : (
                          <StatusDot tone={person.status === 'NEEDS_RECONNECT' ? 'critical' : 'caution'} />
                        )}
                        {person.name}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-sm text-ink-2">Nobody has connected a notetaker yet.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProviderRow({
  meta,
  connection,
  now,
  demo,
}: {
  meta: NotetakerProvider;
  connection: NotetakerConnection | undefined;
  now: number | null;
  demo: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'connect' | 'key' | 'disconnect' | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const status = connection?.status ?? 'DISCONNECTED';
  const connected = status === 'ACTIVE' || status === 'ERROR';
  const line = statusLine(connection, now);

  const signIn = () => {
    setError(null);
    setBusy('connect');
    startTransition(async () => {
      const result = await connectNotetakerAction(meta.id);
      if ('url' in result) {
        window.location.assign(result.url);
        return;
      }
      setError(result.error);
      setBusy(null);
    });
  };

  const saveKey = () => {
    setError(null);
    setBusy('key');
    startTransition(async () => {
      const result = await connectNotetakerKeyAction(meta.id, key);
      setBusy(null);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setKey('');
      setKeyOpen(false);
      router.refresh();
    });
  };

  const disconnect = () => {
    setError(null);
    setBusy('disconnect');
    startTransition(async () => {
      await disconnectNotetakerAction(meta.id);
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
            <SiteIcon url={meta.domain} size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{meta.name}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2">
              {line.tone ? <StatusDot tone={line.tone} /> : null}
              <span className="min-w-0 break-words">{line.text}</span>
            </p>
          </div>
        </div>
        {demo ? null : (
          <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
            {connected ? null : (
              <>
                {meta.apiKey && !keyOpen ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setError(null);
                      setKeyOpen(true);
                    }}
                    className={buttonClass({ variant: 'ghost', size: 'sm' })}
                  >
                    Use an API key
                  </button>
                ) : null}
                <button type="button" disabled={pending} onClick={signIn} className={buttonClass({ variant: 'tonal', size: 'sm' })}>
                  <BusyLabel busy={busy === 'connect'}>{status === 'NEEDS_RECONNECT' ? 'Reconnect' : 'Connect'}</BusyLabel>
                </button>
              </>
            )}
            {status === 'DISCONNECTED' || status === 'PENDING' ? null : (
              <button
                type="button"
                disabled={pending}
                onClick={disconnect}
                className={buttonClass({ variant: 'ghost', size: 'sm', className: 'hover:text-critical' })}
              >
                <BusyLabel busy={busy === 'disconnect'}>Disconnect</BusyLabel>
              </button>
            )}
          </div>
        )}
      </div>

      {keyOpen && meta.apiKey ? (
        <form
          className="mt-3 flex flex-col gap-2 pl-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) saveKey();
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              {...noAutofill}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`${meta.name} API key`}
              aria-label={`${meta.name} API key`}
              className={cn(inputClass, 'sm:max-w-sm')}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button type="submit" disabled={pending || !key.trim()} className={buttonClass({ variant: 'tonal' })}>
                <BusyLabel busy={busy === 'key'}>Save key</BusyLabel>
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setKeyOpen(false);
                  setKey('');
                  setError(null);
                }}
                className={buttonClass({ variant: 'ghost' })}
              >
                Cancel
              </button>
            </div>
          </div>
          <p className="text-xs text-ink-2">{meta.apiKey.where} Source checks the key before saving it, and stores it encrypted.</p>
        </form>
      ) : null}

      {error ? <p className="mt-2 pl-8 text-sm text-critical">{error}</p> : null}
    </div>
  );
}
