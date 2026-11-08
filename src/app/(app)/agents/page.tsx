import { Suspense } from 'react';
import { Bot } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { PageSkeleton } from '@/components/page-skeleton';
import { EmptyState } from '@/components/empty-state';
import { surface } from '@/components/form-controls';
import { Badge, SectionHeader } from '@/components/ui/primitives';
import { RunAgentButton } from '@/components/hr-controls';
import { LocalTime } from '@/components/local-time';
import { requireSession, isAdmin } from '@/lib/session';
import { agentStats, listAgentRuns } from '@/server/hr-agents';

export const metadata = { title: 'AI agents — Orqestra' };

async function AgentsContent() {
  const ctx = await requireSession();
  const admin = isAdmin(ctx);
  const [stats, runs] = await Promise.all([agentStats(ctx.orgId), listAgentRuns(ctx.orgId, undefined, 15)]);
  const ran = stats.some((s) => s.total > 0);

  return (
    <div className="t-reveal">
      <PageHeader
        title="AI agents"
        subtitle="Rule-based HR agents that read real records and report what needs a person. Each run is logged."
      />
      <div className="mx-6 mt-4 flex max-w-5xl flex-col gap-8 pb-10">
        <section className="grid gap-4 md:grid-cols-3">
          {stats.map((s) => (
            <div key={s.key} className={`${surface} flex flex-col gap-3 p-5`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Bot size={16} strokeWidth={1.75} className="text-ink-2" />
                  <h2 className="text-md font-medium">{s.name}</h2>
                </div>
                <Badge tone={s.last?.status === 'FAILED' ? 'critical' : s.last ? 'positive' : 'neutral'}>
                  {s.last ? (s.last.status === 'FAILED' ? 'Failed' : 'Active') : 'Idle'}
                </Badge>
              </div>
              <p className="text-sm text-ink-2">{s.description}</p>
              <dl className="grid grid-cols-3 gap-2 text-xs text-ink-2">
                <div>
                  <dt>Runs</dt>
                  <dd className="text-sm font-medium text-ink">{s.total}</dd>
                </div>
                <div>
                  <dt>Failed</dt>
                  <dd className="text-sm font-medium text-ink">{s.failed}</dd>
                </div>
                <div>
                  <dt>Avg</dt>
                  <dd className="text-sm font-medium text-ink">{s.avgDurationMs} ms</dd>
                </div>
              </dl>
              <p className="min-h-5 text-xs text-ink-2">
                {s.last ? s.last.summary || (s.last.status === 'FAILED' ? 'Last run failed.' : '') : 'Has not run yet.'}
              </p>
              {admin ? (
                <div className="mt-auto">
                  <RunAgentButton agent={s.key} />
                </div>
              ) : null}
            </div>
          ))}
        </section>

        <section>
          <SectionHeader title="Recent runs" />
          {!ran ? (
            <EmptyState
              icon={Bot}
              title="No agent runs yet"
              description="Run an agent to see its findings and execution history here."
            />
          ) : (
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {runs.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {stats.find((s) => s.key === r.agent)?.name ?? r.agent}
                      <span className="ml-2 text-xs font-normal text-ink-2">{r.trigger}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-ink-2">{r.status === 'FAILED' ? r.error : r.summary}</p>
                    {Array.isArray(r.findings) && r.findings.length ? (
                      <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-2">
                        {(r.findings as { severity: string; message: string }[]).slice(0, 8).map((f, i) => (
                          <li key={i} className={f.severity === 'attention' ? 'text-ink' : undefined}>
                            {f.severity === 'attention' ? '● ' : '· '}
                            {f.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right text-xs text-ink-2">
                    <LocalTime date={r.startedAt.toISOString()} options={{ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }} />
                    <p>
                      {r.durationMs} ms · {r.attempts} attempt{r.attempts === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="AI agents" subtitle="Monitor HR agents and their runs" />}>
      <AgentsContent />
    </Suspense>
  );
}
