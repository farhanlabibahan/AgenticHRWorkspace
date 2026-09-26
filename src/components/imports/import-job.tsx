'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check } from 'lucide-react';
import type { StageType } from '@prisma/client';
import type { ImportJobView, ReviewView } from '@/server/imports/jobs';
import type { SliceResult } from '@/server/imports/runner';
import type { MappingInput, ReasonTarget, StageTarget } from '@/server/imports/mapping';
import { cancelImportAction, confirmImportMappingAction } from '@/app/(app)/settings/import/actions';
import {
  COUNT_KINDS,
  formatCount,
  IMPORT_STATUS,
  isOpen,
  isRunning,
  STAGE_TYPE_LABELS,
  timeAgo,
} from '@/components/imports/import-meta';
import { BusyLabel, NativeSelect } from '@/components/imports/fields';
import { inputClass, noAutofill } from '@/components/form-controls';
import { SiteIcon } from '@/components/site-icon';
import { Switch } from '@/components/switch';
import { buttonClass } from '@/components/ui/button';
import { Card, SectionHeader, StatusDot } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The import job page. While the job is DISCOVERING or RUNNING and the tab
 * is visible it keeps calling the advance route, one ~20s slice after
 * another, and renders whatever progress comes back. Nothing depends on the
 * tab staying open — the imports cron carries on without it.
 */

type AdvanceResponse = { result: SliceResult; job: ImportJobView | null };

/** Wait after a 'busy' / 'failed' / 'idle' slice before asking again. */
const SETTLE_MS = 3_000;
/** The provider asked us to slow down; the server holds the job until then. */
const WAITING_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Drive the job forward while it runs and the tab is visible. Stops on
 * unmount and when the status settles; a hidden tab pauses the loop and a
 * visible one resumes it.
 */
function usePump(jobId: string, running: boolean, onJob: (job: ImportJobView) => void) {
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const controller = new AbortController();

    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(tick, ms);
    };

    async function tick() {
      timer = null;
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const res = await fetch(`/api/imports/${jobId}/advance`, { method: 'POST', signal: controller.signal });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          stopped = true;
          return;
        }
        if (!res.ok) throw new Error(`advance ${res.status}`);
        const data = (await res.json()) as AdvanceResponse;
        if (stopped) return;
        failures = 0;
        if (data.job) onJob(data.job);
        if (data.job && !isRunning(data.job.status)) return; // settled; the effect re-arms if it runs again
        schedule(data.result === 'worked' ? 0 : data.result === 'waiting' ? WAITING_MS : SETTLE_MS);
      } catch {
        if (stopped) return;
        failures++;
        schedule(Math.min(MAX_BACKOFF_MS, SETTLE_MS * 2 ** (failures - 1)));
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !timer && !inFlight) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [jobId, running, onJob]);
}

export function ImportJob({ initial }: { initial: ImportJobView }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  // A server refresh (after confirm/cancel) hands us a newer snapshot.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setJob(initial);
  }

  usePump(job.id, isRunning(job.status), setJob);

  const [canceling, startCancel] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = () => {
    if (!window.confirm(`Cancel this import? Anything already imported from ${job.providerName} stays in Source.`)) return;
    startCancel(async () => {
      const res = await cancelImportAction(job.id);
      if (res.error) {
        setCancelError(res.error);
        return;
      }
      setJob((j) => ({ ...j, status: 'CANCELED', review: null, retrying: false, finishedAt: new Date().toISOString() }));
      router.refresh();
    });
  };

  const status = IMPORT_STATUS[job.status];
  const running = isRunning(job.status);
  const anyCounts = COUNT_KINDS.some(({ kind }) => job.created[kind] || job.linked[kind]);
  const showCounts = job.status === 'RUNNING' || job.status === 'SUCCEEDED' || anyCounts;
  // FAILED/CANCELED phases all read "todo"; SUCCEEDED all "done" — only worth showing while in flight.
  const showPhases = isOpen(job.status) && job.phases.length > 0;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4 px-6 pb-2 pt-8">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <SiteIcon url={job.domain} size={20} />
            <h1 className="text-xl font-medium text-ink">Import from {job.providerName}</h1>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-2">
            <StatusDot tone={status.tone} className={cn(running && 'animate-pulse')} />
            <span className="text-ink">{status.label}</span>
            {job.accountName ? <span>· {job.accountName}</span> : null}
            <span suppressHydrationWarning>
              ·{' '}
              {job.finishedAt ? `Finished ${timeAgo(job.finishedAt)}` : `Started ${timeAgo(job.startedAt)}`}
            </span>
          </p>
        </div>
        {isOpen(job.status) ? (
          <button type="button" onClick={cancel} disabled={canceling} className={buttonClass({ variant: 'secondary' })}>
            <BusyLabel busy={canceling}>Cancel import</BusyLabel>
          </button>
        ) : null}
      </header>

      <div className="mx-6 mt-4 flex max-w-3xl flex-col gap-8 pb-8">
        <StatusNote job={job} cancelError={cancelError} />

        {job.status === 'REVIEW' && job.review ? (
          <MappingReview
            job={job}
            review={job.review}
            onConfirmed={() => {
              setJob((j) => ({ ...j, status: 'RUNNING', review: null }));
              router.refresh();
            }}
          />
        ) : null}

        {showCounts ? <Counts job={job} /> : null}
        {showPhases ? <Phases phases={job.phases} /> : null}
        {job.issues.length ? <Issues job={job} /> : null}
      </div>
    </>
  );
}

// ---------- Status line ----------

function StatusNote({ job, cancelError }: { job: ImportJobView; cancelError: string | null }) {
  // Records an earlier import brought over that changed at the vendor (see Counts).
  const updated = Object.entries(job.stats)
    .filter(([k]) => k.startsWith('updated.'))
    .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
  const contacts = job.created.contact ?? 0;
  const applications = job.created.opportunity ?? 0;
  const postings = job.created.posting ?? 0;

  return (
    <div className="flex flex-col gap-3 empty:hidden">
      {cancelError ? <p className="text-sm text-critical">{cancelError}</p> : null}

      {job.status === 'DISCOVERING' ? (
        <p className="max-w-prose text-sm text-ink-2">
          Reading your stages, archive reasons, and users from {job.providerName}. You&apos;ll choose where
          each stage goes before any candidates are imported.
        </p>
      ) : null}

      {isRunning(job.status) ? (
        <p className="text-xs text-ink-2">
          It&apos;s safe to close this tab. The import keeps running in the background.
        </p>
      ) : null}

      {job.retrying && isRunning(job.status) ? (
        <p className="flex items-center gap-1.5 text-sm text-ink-2">
          <StatusDot tone="caution" /> Retrying after a provider error…
        </p>
      ) : null}

      {job.status === 'SUCCEEDED' ? (
        <Card className="flex flex-col gap-4 p-5">
          <div>
            <p className="text-md font-medium text-ink">Import complete</p>
            <p className="mt-1 text-sm text-ink-2">
              {contacts || applications
                ? `Brought over ${formatCount(contacts)} ${contacts === 1 ? 'candidate' : 'candidates'} and ${formatCount(applications)} ${applications === 1 ? 'application' : 'applications'} from ${job.providerName}.`
                : updated
                  ? `Nothing new to add from ${job.providerName}, and ${formatCount(updated)} ${updated === 1 ? 'record' : 'records'} that changed there ${updated === 1 ? 'is' : 'are'} up to date.`
                  : `Nothing new to bring over from ${job.providerName}. Everything was already in Source.`}
              {(contacts || applications) && updated
                ? ` ${formatCount(updated)} ${updated === 1 ? 'record' : 'records'} imported before ${updated === 1 ? 'was' : 'were'} updated.`
                : null}
              {postings ? ' Open roles come in as drafts, so nothing goes live until you publish it.' : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/contacts" className={buttonClass({ variant: 'primary' })}>
              Open contacts
            </Link>
            <Link href="/postings" className={buttonClass({ variant: 'tonal' })}>
              Open postings
            </Link>
          </div>
        </Card>
      ) : null}

      {job.status === 'FAILED' ? (
        <div className="rounded-card bg-critical/10 p-5">
          <p className="text-md font-medium text-critical">The import stopped</p>
          {job.error ? <p className="mt-1 break-words text-sm text-ink">{job.error}</p> : null}
          <p className="mt-3 max-w-prose text-sm text-ink-2">
            Everything imported before this stays in Source. Fix the problem and start a new import. It skips
            what&apos;s already here and picks up the rest.
          </p>
          <Link href="/settings/import" className={buttonClass({ variant: 'secondary', className: 'mt-4' })}>
            Start a new import
          </Link>
        </div>
      ) : null}

      {job.status === 'CANCELED' ? (
        <p className="max-w-prose text-sm text-ink-2">
          This import was canceled. Anything imported before then stays in Source, and a new import skips it.
        </p>
      ) : null}
    </div>
  );
}

// ---------- Counts ----------

function Counts({ job }: { job: ImportJobView }) {
  const count = (bucket: string, kind: string) => Number(job.stats[`${bucket}.${kind}`]) || 0;
  const total = (match: (key: string) => boolean) =>
    Object.entries(job.stats)
      .filter(([k]) => match(k))
      .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
  const tiles = COUNT_KINDS.filter(
    (k) => k.always || job.created[k.kind] || job.linked[k.kind] || count('updated', k.kind),
  );
  // Records an earlier import brought over: updated where they changed at the
  // vendor, left alone where they didn't ("<kind>.existing" is a file, which
  // never changes), and the team's edits kept.
  const updated = total((k) => k.startsWith('updated.'));
  const unchanged = total((k) => k.startsWith('unchanged.') || k.endsWith('.existing'));
  const kept = total((k) => k.startsWith('kept.'));

  return (
    <section>
      <SectionHeader title={isRunning(job.status) ? 'Imported so far' : 'Imported'} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {tiles.map(({ kind, label }) => {
          const linked = job.linked[kind] ?? 0;
          const changed = count('updated', kind);
          return (
            <Card key={kind} className="flex flex-col p-4">
              <span className="text-2xl text-ink tabular-nums">{formatCount(job.created[kind] ?? 0)}</span>
              <span className="mt-1 text-xs text-ink-2">{label}</span>
              {linked ? (
                <span className="mt-0.5 text-xs text-ink-2 tabular-nums">{formatCount(linked)} matched existing</span>
              ) : null}
              {changed ? <span className="mt-0.5 text-xs text-ink-2 tabular-nums">{formatCount(changed)} updated</span> : null}
            </Card>
          );
        })}
      </div>
      {updated || unchanged ? (
        <p className="mt-3 text-xs text-ink-2 tabular-nums">
          {[
            updated ? `Updated ${formatCount(updated)} ${updated === 1 ? 'record' : 'records'} that changed in ${job.providerName}` : null,
            unchanged ? `${formatCount(unchanged)} unchanged since the last import` : null,
            kept ? `your team’s edits kept on ${formatCount(kept)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      ) : null}
    </section>
  );
}

// ---------- Phases ----------

const GROUP_LABEL = { discover: 'Reading your setup', load: 'Importing' } as const;

function Phases({ phases }: { phases: ImportJobView['phases'] }) {
  const groups = (['discover', 'load'] as const)
    .map((g) => ({ group: g, items: phases.filter((p) => p.group === g) }))
    .filter((g) => g.items.length);

  return (
    <section>
      <SectionHeader title="Progress" />
      <Card className="grid gap-6 p-5 sm:grid-cols-2">
        {groups.map(({ group, items }) => (
          <div key={group}>
            <p className="text-xs font-medium text-ink-2">{GROUP_LABEL[group]}</p>
            <ol className="mt-2 flex flex-col">
              {items.map((p) => (
                <li
                  key={`${p.group}:${p.id}`}
                  aria-current={p.state === 'current' ? 'step' : undefined}
                  className="flex h-8 items-center gap-2.5 text-sm"
                >
                  <span className="grid size-3.5 shrink-0 place-items-center">
                    {p.state === 'done' ? (
                      <Check size={14} className="text-ink-2" aria-label="Done" />
                    ) : p.state === 'current' ? (
                      <StatusDot tone="info" className="animate-pulse" />
                    ) : (
                      <StatusDot />
                    )}
                  </span>
                  <span
                    className={cn(
                      'truncate',
                      p.state === 'current' ? 'font-medium text-ink' : p.state === 'done' ? 'text-ink' : 'text-ink-2',
                    )}
                  >
                    {p.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </Card>
    </section>
  );
}

// ---------- Issues ----------

const ISSUES_SHOWN = 5;

function Issues({ job }: { job: ImportJobView }) {
  const [all, setAll] = useState(false);
  const shown = all ? job.issues : job.issues.slice(0, ISSUES_SHOWN);

  return (
    <section>
      <SectionHeader
        title={`Issues · ${formatCount(job.issueCount)}`}
        action={
          job.issues.length > ISSUES_SHOWN ? (
            <button type="button" onClick={() => setAll((a) => !a)} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
              {all ? 'Show fewer' : `Show all ${job.issues.length}`}
            </button>
          ) : null
        }
      />
      <p className="-mt-1 mb-3 text-xs text-ink-2">None of these stopped the import.</p>
      <Card className="divide-y divide-line">
        {shown.map((issue) => (
          <div key={issue.message} className="flex items-start justify-between gap-4 px-4 py-3">
            <p className="min-w-0 break-words text-sm text-ink">{issue.message}</p>
            {issue.count > 1 ? (
              <span className="shrink-0 text-xs text-ink-2 tabular-nums">×{formatCount(issue.count)}</span>
            ) : null}
          </div>
        ))}
      </Card>
    </section>
  );
}

// ---------- Stage & reason review ----------

/** "A", "A and B", "A, B and C" — each name quoted. */
function listNames(names: string[]) {
  const q = names.map((n) => `“${n}”`);
  return q.length < 3 ? q.join(' and ') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

const STAGE_TYPES = Object.keys(STAGE_TYPE_LABELS) as StageType[];
const CREATE = 'create';

function MappingReview({
  job,
  review,
  onConfirmed,
}: {
  job: ImportJobView;
  review: ReviewView;
  onConfirmed: () => void;
}) {
  const [stages, setStages] = useState<Record<string, StageTarget>>(() =>
    Object.fromEntries(review.stages.map((s) => [s.key, s.target])),
  );
  const [reasons, setReasons] = useState<Record<string, ReasonTarget>>(() =>
    Object.fromEntries(review.reasons.map((r) => [r.key, r.target])),
  );
  // A brand-new workspace takes the vendor's pipeline in place of the starter one.
  const [replaceStarters, setReplaceStarters] = useState(review.canReplaceStarters);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Existing stages grouped by type, in pipeline order within each group.
  const stageGroups = STAGE_TYPES.map((type) => ({
    type,
    stages: review.existingStages.filter((s) => s.type === type),
  })).filter((g) => g.stages.length);

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const mapping: MappingInput = { stages, reasons, replaceStarters: replaceStarters && starters.length > 0 };
      const res = await confirmImportMappingAction(job.id, mapping);
      if (res.error) {
        setError(res.error);
        return;
      }
      onConfirmed();
    });

  // Creates that share a name with each other or an existing entry merge into one on confirm.
  const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const countNew = (names: string[], existing: { name: string }[]) => {
    const taken = new Set(existing.map((e) => key(e.name)));
    return new Set(names.map(key).filter((n) => n && !taken.has(n))).size;
  };
  const newStages = countNew(
    Object.values(stages).flatMap((t) => ('create' in t ? [t.create.name] : [])),
    review.existingStages,
  );
  const newReasons = countNew(
    Object.values(reasons).flatMap((t) => ('create' in t ? [t.create.name] : [])),
    review.existingReasons,
  );
  const { users } = review;

  // The starter stages replacing would remove, as the server decides it
  // (dropUnmappedStarters): those no vendor stage lands in, except that an
  // Applicant and a Hired stage always stay.
  const targets = Object.values(stages);
  const mappedIds = new Set(targets.flatMap((t) => ('stageId' in t ? [t.stageId] : [])));
  const covers = (type: StageType) =>
    targets.some((t) => ('create' in t ? t.create.type === type : false)) ||
    review.existingStages.some((st) => st.type === type && mappedIds.has(st.id));
  const kept = new Set(mappedIds);
  for (const type of ['APPLICANT', 'HIRED'] as const) {
    const first = review.existingStages.find((st) => st.type === type);
    if (first && !covers(type)) kept.add(first.id);
  }
  const starters = review.canReplaceStarters ? review.existingStages.filter((st) => !kept.has(st.id)) : [];
  const removing = replaceStarters ? starters.length : 0;

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-prose text-sm text-ink">
        Stages from {job.providerName} are grouped by name. Choose where each one lands in Source. Nothing is
        imported until you start.
      </p>

      <section>
        <SectionHeader title={`Stages · ${review.stages.length}`} />
        <Card className="divide-y divide-line">
          {review.stages.map((s) => {
            const target = stages[s.key];
            const creating = 'create' in target;
            return (
              <MappingRow
                key={s.key}
                name={s.name}
                meta={s.count > 1 ? `Used by ${formatCount(s.count)} pipelines` : null}
                control={
                  <NativeSelect
                    aria-label={`Where "${s.name}" goes`}
                    value={creating ? CREATE : target.stageId}
                    onChange={(v) =>
                      setStages((prev) => ({
                        ...prev,
                        [s.key]:
                          v === CREATE
                            ? {
                                create: {
                                  name: s.name,
                                  type: s.suggestedType,
                                },
                              }
                            : { stageId: v },
                      }))
                    }
                  >
                    <option value={CREATE}>Create new stage</option>
                    {stageGroups.map((g) => (
                      <optgroup key={g.type} label={STAGE_TYPE_LABELS[g.type]}>
                        {g.stages.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </NativeSelect>
                }
              >
                {creating ? (
                  <div className="flex gap-2">
                    <input {...noAutofill}
                      aria-label="New stage name"
                      value={target.create.name}
                      maxLength={80}
                      onChange={(e) =>
                        setStages((prev) => ({
                          ...prev,
                          [s.key]: { create: { ...target.create, name: e.target.value } },
                        }))
                      }
                      className={cn(inputClass, 'min-w-0 flex-1')}
                    />
                    <NativeSelect
                      aria-label="Stage type"
                      value={target.create.type}
                      onChange={(v) =>
                        setStages((prev) => ({
                          ...prev,
                          [s.key]: { create: { ...target.create, type: v as StageType } },
                        }))
                      }
                      className="w-32 shrink-0"
                    >
                      {STAGE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {STAGE_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
              </MappingRow>
            );
          })}
          {!review.stages.length ? (
            <p className="px-4 py-4 text-sm text-ink-2">{job.providerName} didn&apos;t return any stages.</p>
          ) : null}
        </Card>
        {starters.length ? (
          <Card className="mt-3 flex items-start justify-between gap-6 px-4 py-4">
            <div>
              <p className="text-sm text-ink">Use {job.providerName}&apos;s pipeline in place of Source&apos;s starter stages</p>
              <p className="mt-1 text-sm text-ink-2">
                {replaceStarters
                  ? `Removes ${listNames(starters.map((st) => st.name))}, which no ${job.providerName} stage lands in. You can add stages back any time in Settings.`
                  : `${listNames(starters.map((st) => st.name))} stay alongside ${job.providerName}'s stages.`}
              </p>
            </div>
            <Switch
              checked={replaceStarters}
              onChange={setReplaceStarters}
              label={`Use ${job.providerName}'s pipeline in place of Source's starter stages`}
            />
          </Card>
        ) : null}
      </section>

      {review.reasons.length ? (
        <section>
          <SectionHeader title={`Archive reasons · ${review.reasons.length}`} />
          <Card className="divide-y divide-line">
            {review.reasons.map((r) => {
              const target = reasons[r.key];
              const creating = 'create' in target;
              return (
                <MappingRow
                  key={r.key}
                  name={r.name}
                  control={
                    <NativeSelect
                      aria-label={`Where "${r.name}" goes`}
                      value={creating ? CREATE : target.reasonId}
                      onChange={(v) =>
                        setReasons((prev) => ({
                          ...prev,
                          [r.key]:
                            v === CREATE
                              ? {
                                  create: {
                                    name: r.name,
                                    countsAsRejection:
                                      'create' in r.target
                                        ? r.target.create.countsAsRejection
                                        : r.kind === 'rejection' || r.kind === 'other',
                                  },
                                }
                              : { reasonId: v },
                        }))
                      }
                    >
                      <option value={CREATE}>Create new reason</option>
                      {review.existingReasons.length ? (
                        <optgroup label="Your reasons">
                          {review.existingReasons.map((er) => (
                            <option key={er.id} value={er.id}>
                              {er.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </NativeSelect>
                  }
                >
                  {creating ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <input {...noAutofill}
                        aria-label="New reason name"
                        value={target.create.name}
                        maxLength={120}
                        onChange={(e) =>
                          setReasons((prev) => ({
                            ...prev,
                            [r.key]: { create: { ...target.create, name: e.target.value } },
                          }))
                        }
                        className={cn(inputClass, 'min-w-0 sm:flex-1')}
                      />
                      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={target.create.countsAsRejection}
                          onChange={(e) =>
                            setReasons((prev) => ({
                              ...prev,
                              [r.key]: { create: { ...target.create, countsAsRejection: e.target.checked } },
                            }))
                          }
                          className="size-4 accent-ink dark:[color-scheme:dark]"
                        />
                        Counts as rejection
                      </label>
                    </div>
                  ) : null}
                </MappingRow>
              );
            })}
          </Card>
        </section>
      ) : null}

      {users.total ? (
        <section>
          <SectionHeader title="Teammates" />
          <Card className="px-4 py-4">
            <p className="text-sm text-ink">
              {users.matched === users.total
                ? `All ${formatCount(users.total)} ${job.providerName} users matched your team by email.`
                : `${formatCount(users.matched)} of ${formatCount(users.total)} ${job.providerName} users matched to your team by email.`}
            </p>
            {users.matched < users.total ? (
              <>
                <p className="mt-1 text-sm text-ink-2">
                  Notes and scorecards by the others will be credited to you, with the original author&apos;s name
                  kept.
                </p>
                {users.unmatchedNames.length ? (
                  <p className="mt-3 text-xs text-ink-2">
                    Not matched: {users.unmatchedNames.slice(0, 8).join(', ')}
                    {users.total - users.matched > 8 ? `, and ${formatCount(users.total - users.matched - 8)} more` : ''}.
                    Invite them to Source first if you want their work credited to them.
                  </p>
                ) : null}
              </>
            ) : null}
          </Card>
        </section>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={confirm} disabled={pending} className={buttonClass({ variant: 'primary' })}>
            <BusyLabel busy={pending}>Start importing</BusyLabel>
          </button>
          {newStages || newReasons || removing ? (
            <p className="text-xs text-ink-2">
              {newStages || newReasons
                ? `${[
                    newStages ? `${newStages} new ${newStages === 1 ? 'stage' : 'stages'}` : null,
                    newReasons ? `${newReasons} new ${newReasons === 1 ? 'reason' : 'reasons'}` : null,
                  ]
                    .filter(Boolean)
                    .join(' and ')} will be added to your settings.`
                : null}
              {removing ? ` ${removing} starter ${removing === 1 ? 'stage' : 'stages'} will be removed.` : null}
            </p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-critical">{error}</p> : null}
      </div>
    </div>
  );
}

/** Vendor name on the left, where it goes on the right; the create fields drop below. */
function MappingRow({
  name,
  meta,
  control,
  children,
}: {
  name: string;
  meta?: string | null;
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] sm:items-center sm:gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{name}</p>
          {meta ? <p className="text-xs text-ink-2 tabular-nums">{meta}</p> : null}
        </div>
        <ArrowRight size={14} aria-hidden className="hidden text-ink-3 sm:block" />
        {control}
      </div>
      {children ? <div className="sm:ml-[calc(50%+20px)]">{children}</div> : null}
    </div>
  );
}

