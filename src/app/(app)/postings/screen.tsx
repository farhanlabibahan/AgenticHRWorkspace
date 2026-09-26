import Link from 'next/link';
import { Briefcase, Eye, Plus, Search } from 'lucide-react';
import type { loadPostingsPage } from '@/app/(app)/page-loaders';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { PostingStateBadge, PostingStateMenu, PostingStateScope } from '@/components/posting-state-menu';
import { POSTING_STATE_BADGES as STATE_BADGES } from '@/lib/posting-states';
import { RequisitionsManager } from '@/components/requisitions-manager';
import { RequisitionLink } from '@/components/requisition-link';
import { btnPrimary, inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Orb } from '@/components/ui/orb';
import { Badge, Card, Chip, SectionHeader, Segmented, StatusDot } from '@/components/ui/primitives';

const COMMITMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
  INTERNSHIP: 'Internship',
};

const WORKPLACE_LABELS: Record<string, string> = {
  ONSITE: 'In-office',
  HYBRID: 'Hybrid',
  REMOTE: 'Remote',
};

const VISIBILITY = [
  { key: '', label: 'All open jobs', tone: 'neutral' },
  { key: 'PUBLISHED', label: 'External', tone: 'positive' },
  { key: 'INTERNAL', label: 'Internal only', tone: 'info' },
] as const;

export function PostingsScreen({ data }: { data: Awaited<ReturnType<typeof loadPostingsPage>> }) {
  const href = (over: Record<string, string>) => {
    const params = new URLSearchParams();
    const merged = {
      status: data.archived ? 'archived' : '',
      state: data.stateFilter,
      q: data.q,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const qs = params.toString();
    return qs ? `/postings?${qs}` : '/postings';
  };

  // Drafts carry only id + title; borrow the state from the table when it's in view.
  const stateOf = (id: string) => data.rows.find((r) => r.id === id)?.state ?? 'DRAFT';

  return (
    <div className="t-reveal flex h-screen flex-col">
      <PageHeader
        title="Postings"
        subtitle="Draft, publish, and distribute open roles"
        actions={
          <Link href="/postings/new" className={btnPrimary}>
            <Plus /> Add new job
          </Link>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={data.archived ? 'archived' : 'active'}
            items={[
              { value: 'active', label: 'Active', href: href({ status: '', state: '' }) },
              { value: 'archived', label: 'Archived', href: href({ status: 'archived', state: '' }) },
            ]}
          />
          {!data.archived
            ? VISIBILITY.map((v) => (
                <Chip key={v.key} href={href({ state: v.key })} selected={data.stateFilter === v.key}>
                  <StatusDot tone={v.tone} />
                  {v.label}
                </Chip>
              ))
            : null}
          <form method="get" action="/postings" className="relative ml-auto w-full max-w-xs">
            {data.archived ? <input type="hidden" name="status" value="archived" /> : null}
            {data.stateFilter ? <input type="hidden" name="state" value={data.stateFilter} /> : null}
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input {...noAutofill}
              type="search"
              name="q"
              defaultValue={data.q}
              placeholder="Search roles, clients, locations…"
              aria-label="Search postings"
              className={`${inputClass} pl-9`}
            />
          </form>
        </div>

        {data.rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title={data.archived ? 'No archived postings' : 'No postings match'}
            description={
              data.archived
                ? 'Closed roles will appear here.'
                : 'Create a posting to start collecting candidates against a role.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-card bg-surface">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  {[
                    'Role',
                    'Organization',
                    'Link',
                    'Work arrangement',
                    'Employment type',
                    'Location',
                    'Req',
                    'State',
                    '',
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-medium text-ink-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((p) => {
                  const logoId = p.logoFileId ?? data.org?.logoFileId ?? null;
                  return (
                    <PostingStateScope
                      key={p.id}
                      postingId={p.id}
                      state={p.state}
                      isAdmin={data.isAdmin}
                      requireApproval={data.org?.requirePostingApproval ?? false}
                    >
                      <tr className="transition-colors duration-[120ms] hover:bg-muted/60">
                        <td className="px-4 py-3 font-medium">
                          <Link href={`/postings/${p.id}`} className="flex items-center gap-3 hover:underline">
                            <Orb seed={p.id} size={24} />
                            <span className="truncate">{p.title}</span>
                          </Link>
                        </td>
                        <td className="max-w-52 px-4 py-3 text-ink-2">
                          <span className="flex items-center gap-2.5">
                            {logoId ? (
                              // eslint-disable-next-line @next/next/no-img-element -- uploaded logo via public route
                              <img
                                src={`/api/logo/${logoId}`}
                                alt=""
                                className="size-6 shrink-0 rounded-field bg-white object-contain p-0.5"
                              />
                            ) : (
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-field bg-muted text-2xs font-medium text-ink">
                                {p.orgLabel.slice(0, 1)}
                              </span>
                            )}
                            <span className="truncate">{p.orgLabel}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {p.state === 'PUBLISHED' && data.org?.slug ? (
                            <a
                              href={`/careers/${data.org.slug}/${p.slug}`}
                              target="_blank"
                              className={buttonClass({ variant: 'ghost', size: 'xs' })}
                            >
                              <Eye /> View
                            </a>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-ink-2">
                          {WORKPLACE_LABELS[p.workplaceType] ?? p.workplaceType}
                        </td>
                        <td className="px-4 py-3 text-ink-2">
                          {COMMITMENT_LABELS[p.commitment] ?? p.commitment}
                        </td>
                        <td className="px-4 py-3 text-ink-2">{p.location ?? '—'}</td>
                        <td className="px-4 py-3">
                          <RequisitionLink
                            postingId={p.id}
                            requisitionId={p.requisitionId}
                            requisitions={data.openReqs}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <PostingStateBadge />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PostingStateMenu />
                        </td>
                      </tr>
                    </PostingStateScope>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!data.archived && data.drafts.length ? (
          <section className="mt-8">
            <SectionHeader title="Drafts" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {data.drafts.map((d) => {
                const state = STATE_BADGES[stateOf(d.id)] ?? STATE_BADGES.DRAFT;
                return (
                  <Link key={d.id} href={`/postings/${d.id}`}>
                    <Card interactive className="h-full p-4">
                      <div className="flex items-start justify-between">
                        <Orb seed={d.id} size={40} />
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </div>
                      <h3 className="mt-6 truncate text-md font-medium">{d.title}</h3>
                      <p className="mt-1 text-sm text-ink-2">Not yet published</p>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}

        <RequisitionsManager requisitions={data.requisitions} />
        <div className="pb-8" />
      </div>
    </div>
  );
}
