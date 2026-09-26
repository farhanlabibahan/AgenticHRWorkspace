'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, Eye, EyeOff, Info } from 'lucide-react';
import { startImportAction, testImportConnectionAction } from '@/app/(app)/settings/import/actions';
import { IMPORT_PROVIDERS, type CredentialField, type ProviderMeta } from '@/lib/import-providers';
import { inputClass, noAutofill } from '@/components/form-controls';
import { BusyLabel, NativeSelect } from '@/components/imports/fields';
import { SiteIcon } from '@/components/site-icon';
import { buttonClass } from '@/components/ui/button';
import { Card, SectionHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Settings → Import, the "new import" half: pick the ATS, paste its key,
 * choose what comes across, start. Credentials live only in component state
 * — never logged, never stored in the browser — and the secret fields are
 * cleared once the job has them.
 */

type Options = { archived: boolean; activity: boolean; offers: boolean; files: boolean; since: string };

const DEFAULT_OPTIONS: Options = { archived: true, activity: true, offers: true, files: true, since: '' };

const OPTION_ROWS: { key: Exclude<keyof Options, 'since'>; label: string; hint: string }[] = [
  {
    key: 'archived',
    label: 'Archived and hired candidates',
    hint: 'Turn off to bring only candidates who are still in process.',
  },
  { key: 'activity', label: 'Notes, scorecards, and interviews', hint: 'Original authors and dates are kept.' },
  { key: 'offers', label: 'Offers', hint: 'Status, salary, and start date.' },
  {
    key: 'files',
    label: 'Resumes and attachments',
    hint: 'The slowest part of an import. Resume text becomes searchable.',
  },
];

/** "Candidates" → "candidates" mid-sentence, but "EEO data" stays as it is. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function initialCredentials(meta: ProviderMeta): Record<string, string> {
  return Object.fromEntries(
    meta.fields.map((f) => [f.key, f.defaultValue ?? (f.kind === 'select' ? (f.options?.[0]?.value ?? '') : '')]),
  );
}

/** Caveats shown before "Show more". */
const NOTES_SHOWN = 3;

export function NewImport({
  blocked,
  retentionMonths,
  importedFrom = [],
  initialProvider = null,
}: {
  blocked: boolean;
  retentionMonths: number | null;
  /** Providers this org has finished an import from: importing again updates what changed. */
  importedFrom?: string[];
  /** Opens on this provider's form (onboarding hands it over as ?provider=). */
  initialProvider?: string | null;
}) {
  const [providerId, setProviderId] = useState<string | null>(initialProvider);
  const meta = IMPORT_PROVIDERS.find((p) => p.id === providerId) ?? null;

  if (!meta) {
    return (
      <section>
        <SectionHeader title="Choose your current ATS" />
        {IMPORT_PROVIDERS.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {IMPORT_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProviderId(p.id)}
                className="flex flex-col items-start gap-3 rounded-card bg-surface p-4 text-left outline-none transition-shadow duration-200 ease-[var(--ease-standard)] hover:shadow-lift focus-visible:ring-2 focus-visible:ring-line-strong"
              >
                <SiteIcon url={p.domain} size={20} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-md font-medium text-ink">{p.name}</span>
                  <span className="text-sm text-ink-2">{p.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Card className="px-4 py-4">
            <p className="text-sm text-ink-2">No importers are available on this deployment yet.</p>
          </Card>
        )}
        <p className="mt-3 text-xs text-ink-2">
          Not listed? Export your candidates to a CSV and use{' '}
          <Link href="/settings?section=data" className="text-ink underline underline-offset-2">
            Contact import
          </Link>
          .
        </p>
      </section>
    );
  }

  // Keyed so switching providers starts from a clean form (and clean credentials).
  return (
    <ConnectForm
      key={meta.id}
      meta={meta}
      blocked={blocked}
      retentionMonths={retentionMonths}
      reimport={importedFrom.includes(meta.id)}
      onChange={() => setProviderId(null)}
    />
  );
}

function ConnectForm({
  meta,
  blocked,
  retentionMonths,
  reimport,
  onChange,
}: {
  meta: ProviderMeta;
  blocked: boolean;
  retentionMonths: number | null;
  reimport: boolean;
  onChange: () => void;
}) {
  const router = useRouter();
  const [credentials, setCredentials] = useState<Record<string, string>>(() => initialCredentials(meta));
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [test, setTest] = useState<{ ok: true; accountName: string } | { ok: false; error: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [testing, startTesting] = useTransition();
  const [starting, startStarting] = useTransition();

  const complete = meta.fields.every((f) => f.optional || credentials[f.key]?.trim());
  // The org's retention policy applies to imported history too — say so before it runs.
  const notes = [
    ...(reimport
      ? [
          meta.updatesOnReimport
            ? `You've imported from ${meta.name} before. This adds anyone new and updates candidates, applications, notes and jobs that changed in ${meta.name} since. Changes your team made in Source stay, and nothing is deleted.`
            : `You've imported from ${meta.name} before. This adds anyone new; records already imported stay as they are in Source.`,
        ]
      : []),
    ...(retentionMonths
      ? [
          `Your retention policy anonymizes candidates archived more than ${retentionMonths} months ago. Imported candidates archived before then are anonymized overnight; their stage history stays for reports.`,
        ]
      : []),
    ...(meta.caveats ?? []),
  ];
  // Caveats are honest and specific, so there can be many; lead with the first few.
  const [allNotes, setAllNotes] = useState(false);
  const shownNotes = allNotes ? notes : notes.slice(0, NOTES_SHOWN);
  const busy = testing || starting;

  const setField = (key: string, value: string) => {
    setCredentials((c) => ({ ...c, [key]: value }));
    setTest(null); // a changed key needs a fresh test
    setStartError(null);
  };

  const runTest = () =>
    startTesting(async () => {
      setStartError(null);
      setTest(await testImportConnectionAction(meta.id, credentials));
    });

  const start = () =>
    startStarting(async () => {
      setStartError(null);
      const result = await startImportAction(meta.id, credentials, {
        archived: options.archived,
        activity: options.activity,
        offers: options.offers,
        files: options.files,
        since: options.since || null,
      });
      if (!result.ok) {
        setStartError(result.error);
        return;
      }
      // The job holds its own sealed copy now; drop ours.
      setCredentials((c) => {
        const next = { ...c };
        for (const f of meta.fields) if (f.kind === 'secret') next[f.key] = '';
        return next;
      });
      router.push(`/settings/import/${result.jobId}`);
    });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <section>
      <SectionHeader
        title="New import"
        action={
          <button type="button" onClick={onChange} disabled={busy} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
            Choose a different ATS
          </button>
        }
      />
      <Card className="divide-y divide-line">
        <div className="flex items-start gap-3 px-5 py-5">
          <span className="mt-0.5">
            <SiteIcon url={meta.domain} size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-md font-medium text-ink">Import from {meta.name}</h2>
            {meta.imports.length ? (
              <p className="mt-1 text-sm text-ink-2">
                Brings over {new Intl.ListFormat('en', { type: 'conjunction' }).format(meta.imports.map(lowerFirst))}.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">{meta.blurb}</p>
            )}
          </div>
        </div>

        {meta.steps.length ? (
          <div className="px-5 py-5">
            <h3 className="text-sm font-medium text-ink">Where to find your key</h3>
            <ol className="mt-3 flex flex-col gap-2.5">
              {meta.steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-sm text-ink">
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-muted text-2xs text-ink-2 tabular-nums">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
            {meta.docsUrl ? (
              <a
                href={meta.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-2 underline-offset-2 transition-colors duration-[120ms] hover:text-ink hover:underline"
              >
                {meta.name} help article <ExternalLink size={13} aria-hidden />
              </a>
            ) : null}
          </div>
        ) : null}

        <form
          className="px-5 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete && !busy) runTest();
          }}
        >
          <div className="flex max-w-[560px] flex-col gap-4">
            {meta.fields.map((field) => (
              <CredentialInput
                key={field.key}
                field={field}
                value={credentials[field.key] ?? ''}
                onChange={(v) => setField(field.key, v)}
              />
            ))}
          </div>
          {/* Enter in a field tests the connection; starting is always an explicit click. */}
          <button type="submit" hidden tabIndex={-1} aria-hidden />
        </form>

        {notes.length ? (
          <div className="px-5 py-5">
            <h3 className="text-sm font-medium text-ink">Good to know</h3>
            <ul className="mt-3 flex flex-col gap-2">
              {shownNotes.map((c, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-ink-2">
                  <Info size={14} aria-hidden className="mt-[3px] shrink-0" />
                  <span className="min-w-0">{c}</span>
                </li>
              ))}
            </ul>
            {notes.length > NOTES_SHOWN ? (
              <button
                type="button"
                onClick={() => setAllNotes((a) => !a)}
                className={`mt-2 ${buttonClass({ variant: 'ghost', size: 'xs' })}`}
              >
                {allNotes ? 'Show fewer' : `Show ${notes.length - NOTES_SHOWN} more`}
              </button>
            ) : null}
          </div>
        ) : null}

        <fieldset className="px-5 py-5">
          <legend className="float-left text-sm font-medium text-ink">What to bring over</legend>
          <p className="clear-left pt-1 text-xs text-ink-2">Candidates, applications, and postings always come across.</p>
          <div className="mt-4 flex flex-col gap-3">
            {OPTION_ROWS.map((o) => (
              <label key={o.key} className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={options[o.key]}
                  onChange={(e) => setOptions((prev) => ({ ...prev, [o.key]: e.target.checked }))}
                  className="mt-0.5 size-4 shrink-0 accent-ink dark:[color-scheme:dark]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">{o.label}</span>
                  <span className="text-xs text-ink-2">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="mt-5 flex max-w-xs flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">
              Only candidates added since <span className="font-normal text-ink-2">(optional)</span>
            </span>
            <input {...noAutofill}
              type="date"
              value={options.since}
              max={today}
              onChange={(e) => setOptions((prev) => ({ ...prev, since: e.target.value }))}
              className={cn(inputClass, 'dark:[color-scheme:dark]', !options.since && 'text-ink-3')}
            />
            <span className="text-xs text-ink-2">Leave empty to import everyone.</span>
          </label>
        </fieldset>

        <div className="flex flex-col gap-3 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={!complete || busy}
              className={buttonClass({ variant: 'tonal' })}
            >
              <BusyLabel busy={testing}>Test connection</BusyLabel>
            </button>
            <button
              type="button"
              onClick={start}
              disabled={!complete || busy || blocked}
              className={buttonClass({ variant: 'primary', className: 'sm:ml-auto' })}
            >
              <BusyLabel busy={starting}>{reimport ? 'Import again' : 'Start import'}</BusyLabel>
            </button>
          </div>
          <div aria-live="polite" className="flex flex-col gap-1 empty:hidden">
            {test?.ok ? (
              <p className="flex items-center gap-1.5 text-sm text-positive">
                <Check size={14} aria-hidden /> Connected to {test.accountName}
              </p>
            ) : test ? (
              <p className="text-sm text-critical">{test.error}</p>
            ) : null}
            {startError ? <p className="text-sm text-critical">{startError}</p> : null}
            {blocked ? (
              <p className="text-sm text-ink-2">You can start a new import when the current one finishes.</p>
            ) : starting ? (
              <p className="text-sm text-ink-2">Checking the connection with {meta.name}…</p>
            ) : null}
          </div>
        </div>
      </Card>
    </section>
  );
}

function CredentialInput({
  field,
  value,
  onChange,
}: {
  field: CredentialField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const id = `cred-${field.key}`;
  const helpId = field.help ? `${id}-help` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {field.label}
        {field.optional ? <span className="font-normal text-ink-2"> (optional)</span> : null}
      </label>
      {field.kind === 'select' ? (
        <NativeSelect id={id} value={value} onChange={onChange} aria-describedby={helpId}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      ) : field.kind === 'secret' ? (
        <div className="relative">
          <input {...noAutofill}
            id={id}
            type={shown ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            aria-describedby={helpId}
            required={!field.optional}
            spellCheck={false}
            // Keep password managers from offering to save an API key.
            data-1p-ignore
            data-lpignore="true"
            className={cn(inputClass, 'pr-10 font-mono text-xs placeholder:font-sans placeholder:text-sm')}
          />
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? `Hide ${field.label}` : `Show ${field.label}`}
            aria-pressed={shown}
            className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-2 transition-colors duration-[120ms] hover:bg-ink/[0.05] hover:text-ink"
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      ) : (
        <input {...noAutofill}
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          aria-describedby={helpId}
          required={!field.optional}
          spellCheck={false}
          className={inputClass}
        />
      )}
      {field.help ? (
        <p id={helpId} className="text-xs text-ink-2">
          {field.help}
        </p>
      ) : null}
    </div>
  );
}
