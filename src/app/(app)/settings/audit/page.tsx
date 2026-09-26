import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Search } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { PageHeader } from '@/components/page-header';
import { btnSecondary, inputClass, badge, surface, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 100;

/** Org-wide admin-visible audit trail over the event stream (docs/02 §11). */
export const metadata = { title: 'Audit log — Source' };

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ verb?: string; page?: string }>;
}) {
  const ctx = await requireSession();
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN') redirect('/settings');

  const { verb = '', page = '0' } = await searchParams;
  const pageNum = Math.max(0, Number.parseInt(page, 10) || 0);
  const where = {
    orgId: ctx.orgId,
    ...(verb.trim() ? { verb: { contains: verb.trim(), mode: 'insensitive' as const } } : {}),
  };

  const [events, total, actors] = await Promise.all([
    db.event.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: pageNum * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.event.count({ where }),
    db.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
  ]);
  const actorName = new Map(actors.map((a) => [a.id, a.name]));

  return (
    <div>
      <div className="px-6 pt-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors duration-[120ms] hover:text-ink"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
      </div>
      <PageHeader title="Audit log" subtitle={`${total.toLocaleString()} events — every action, by everyone, forever`} />

      <div className="mx-6 mt-4 max-w-5xl pb-8">
        <div className="mb-4 flex items-center gap-2">
          <form method="get" className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <Search
                size={16}
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input {...noAutofill}
                type="search"
                name="verb"
                defaultValue={verb}
                placeholder="Filter by verb: opportunity.stage_changed, email., user.…"
                className={cn(inputClass, 'pl-9')}
              />
            </div>
            <button type="submit" className={btnSecondary}>
              Filter
            </button>
          </form>
          <a
            href={`/api/audit/export${verb ? `?verb=${encodeURIComponent(verb)}` : ''}`}
            className={btnSecondary}
          >
            Export CSV
          </a>
        </div>

        <div className={`${surface} overflow-hidden`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {['When', 'Actor', 'Verb', 'Subject', 'Detail'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-xs font-medium text-ink-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-line transition-colors duration-[120ms] last:border-0 hover:bg-muted/60"
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-2 tabular-nums">
                    {e.occurredAt.toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-2.5">
                    {e.actorType === 'user'
                      ? (actorName.get(e.actorId ?? '') ?? 'Unknown user')
                      : e.actorType.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={badge}>{e.verb}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-2">
                    {e.subjectType}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-ink-2">
                    {e.payload ? JSON.stringify(e.payload) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-ink-2 tabular-nums">
          <span>
            Page {pageNum + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <span className="flex gap-2">
            {pageNum > 0 ? (
              <Link
                href={`?verb=${encodeURIComponent(verb)}&page=${pageNum - 1}`}
                className={buttonClass({ variant: 'secondary', size: 'sm' })}
              >
                Newer
              </Link>
            ) : null}
            {(pageNum + 1) * PAGE_SIZE < total ? (
              <Link
                href={`?verb=${encodeURIComponent(verb)}&page=${pageNum + 1}`}
                className={buttonClass({ variant: 'secondary', size: 'sm' })}
              >
                Older
              </Link>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
