import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { firstParams, type SearchParams } from '@/lib/utils';
import { reportBuilderCounts, type BuilderFilters, type BuilderGroupBy } from '@/server/analytics';
import { PageHeader } from '@/components/page-header';
import { SaveReportButton } from '@/components/save-report-button';
import { Field, btnPrimary, inputClass, surface, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/primitives';
import { FormSelect } from '@/components/form-select';
import { DitherBar } from '@/components/ui/dither';

const GROUP_DIMENSIONS = [
  { value: 'stage', label: 'Stage' },
  { value: 'origin', label: 'Origin' },
  { value: 'source', label: 'Source' },
  { value: 'posting', label: 'Posting' },
  { value: 'archiveReason', label: 'Archive reason' },
  { value: 'owner', label: 'Owner' },
  { value: 'month', label: 'Month added' },
] as const;

type Params = {
  groupBy?: string;
  status?: string;
  origin?: string;
  posting?: string;
  from?: string;
  to?: string;
};

/**
 * Custom report builder (docs/02 §9): count opportunities grouped by any
 * dimension, filtered by status/origin/posting/date range. Configs are
 * shareable URLs and saveable to Reports.
 */
export const metadata = { title: 'Report builder — Orqestra' };

export default async function ReportBuilderPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const ctx = await requireSession();
  const params: Params = await firstParams(searchParams);
  const groupBy = GROUP_DIMENSIONS.some((d) => d.value === params.groupBy)
    ? (params.groupBy as string)
    : 'stage';

  const status = ['ACTIVE', 'HIRED', 'ARCHIVED'].includes(params.status ?? '')
    ? (params.status as BuilderFilters['status'])
    : undefined;
  const [data, postings] = await Promise.all([
    reportBuilderCounts(ctx.orgId, groupBy as BuilderGroupBy, {
      status,
      origin: params.origin || undefined,
      postingId: params.posting || undefined,
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(`${params.to}T23:59:59Z`) : undefined,
    }),
    db.posting.findMany({ where: { orgId: ctx.orgId }, orderBy: { title: 'asc' } }),
  ]);
  const max = Math.max(...data.map((d) => d.count), 1);
  const total = data.reduce((n, d) => n + d.count, 0);

  const config: Record<string, string> = { groupBy };
  for (const k of ['status', 'origin', 'posting', 'from', 'to'] as const) {
    if (params[k]) config[k] = params[k]!;
  }
  const csv = [
    `${groupBy},count`,
    ...data.map((d) => `${/[",\n]/.test(d.name) ? `"${d.name.replace(/"/g, '""')}"` : d.name},${d.count}`),
  ].join('\n');

  return (
    <div>
      <div className="px-6 pt-6">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors duration-[120ms] hover:text-ink"
        >
          <ArrowLeft size={14} /> Reports
        </Link>
      </div>
      <PageHeader title="Report builder" subtitle="Group and filter your pipeline any way you need" />

      <div className="mx-6 mt-4 flex max-w-3xl flex-col gap-8 pb-8">
        <form method="get" className={`${surface} grid gap-4 p-5 sm:grid-cols-3`}>
          <Field label="Group by">
            <FormSelect
              name="groupBy"
              defaultValue={groupBy}
              options={GROUP_DIMENSIONS.map((d) => ({ value: d.value, label: d.label }))}
            />
          </Field>
          <Field label="Status">
            <FormSelect
              name="status"
              defaultValue={params.status ?? ''}
              options={[
                { value: '', label: 'Any' },
                { value: 'ACTIVE', label: 'Active' },
                { value: 'HIRED', label: 'Hired' },
                { value: 'ARCHIVED', label: 'Archived' },
              ]}
            />
          </Field>
          <Field label="Posting">
            <FormSelect
              name="posting"
              defaultValue={params.posting ?? ''}
              options={[
                { value: '', label: 'Any' },
                ...postings.map((p) => ({ value: p.id, label: p.title })),
              ]}
            />
          </Field>
          <Field label="Added from">
            <input {...noAutofill} type="date" name="from" defaultValue={params.from ?? ''} className={inputClass} />
          </Field>
          <Field label="Added to">
            <input {...noAutofill} type="date" name="to" defaultValue={params.to ?? ''} className={inputClass} />
          </Field>
          <div className="flex items-end gap-2">
            <button type="submit" className={btnPrimary}>
              Run report
            </button>
          </div>
        </form>

        <section>
          <SectionHeader
            title={
              <span className="tabular-nums">
                {total.toLocaleString()} opportunities by{' '}
                {GROUP_DIMENSIONS.find((d) => d.value === groupBy)?.label.toLowerCase()}
              </span>
            }
            action={
              <div className="flex items-center gap-2">
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
                  download="source-report.csv"
                  className={buttonClass({ variant: 'secondary', size: 'sm' })}
                >
                  CSV
                </a>
                <SaveReportButton config={config} />
              </div>
            }
          />
          <div className={`${surface} flex flex-col gap-3 p-5`}>
            {data.map((d) => (
              <div key={d.name} className="grid grid-cols-[160px_1fr_40px] items-center gap-3">
                <span className="truncate text-sm">{d.name}</span>
                <DitherBar value={d.count} max={max} label={`${d.name}: ${d.count}`} />
                <span className="text-right text-xs text-ink-2 tabular-nums">{d.count}</span>
              </div>
            ))}
            {data.length === 0 ? (
              <p className="text-sm text-ink-2">No opportunities match these filters.</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
