import Link from 'next/link';
import {
  ArrowRight,
  BadgeCheck,
  Braces,
  Database,
  FileText,
  Inbox,
  MessagesSquare,
  Monitor,
  Server,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { db } from '@/lib/db';
import { SourceLockup } from '@/components/powered-by';
import { getCentralDocsOrg, getLiveDocsData, isPublished, publicApi, readContent, readTeam, type DocsContent } from '@/lib/docs-site';
import { DocsNav, SIDEBAR_BOOT } from './docs-nav';
import { CopyRoute, CountUp } from './docs-client';
import './docs.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documentation — Orqestra', description: 'Product overview and technical documentation' };

const utc = (iso: string) =>
  new Date(iso).toLocaleString('en', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';

/** Section heading: one real heading, an optional one-line aside on the right. */
function Heading({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
      <h2 className="max-w-2xl text-2xl font-semibold">{title}</h2>
      {aside ? <div className="text-xs md:text-right">{aside}</div> : null}
    </div>
  );
}

function IconDot({ icon: Icon, inverted }: { icon: LucideIcon; inverted?: boolean }) {
  return (
    <span className={inverted ? 'grid size-9 place-items-center rounded-full bg-on-brand/15 text-on-brand' : 'grid size-9 place-items-center rounded-full bg-recessed text-brand'}>
      <Icon size={16} strokeWidth={1.75} />
    </span>
  );
}

/** A row of nodes joined by flowing connectors; stacks vertically on phones. */
function FlowDiagram({ label, nodes }: { label: string; nodes: { icon: LucideIcon; text: string }[] }) {
  return (
    <div role="img" aria-label={`${label}: ${nodes.map((n) => n.text).join(' to ')}`} className="flex flex-col items-stretch md:flex-row md:items-center">
      {nodes.map((n, i) => (
        <div key={n.text} className="flex flex-col items-center md:flex-1 md:flex-row">
          <div className="dx-card flex w-full flex-col items-center gap-3 rounded-2xl bg-canvas px-3 py-4 text-center shadow-[0_0_0_1px_var(--color-line)]">
            <IconDot icon={n.icon} />
            <span className="text-xs font-medium leading-snug">{n.text}</span>
          </div>
          {i < nodes.length - 1 ? (
            <>
              <span aria-hidden className="dx-flow-v my-1 h-7 w-[2px] md:hidden" />
              <span aria-hidden className="dx-flow mx-1 hidden h-[2px] w-8 shrink-0 md:block" />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Split a free-text stack line into chips when it is a plain list; otherwise null. */
function stackChips(stack: string): string[] | null {
  const first = stack.split(/\.\s+/)[0].replace(/\.$/, '');
  const parts = first.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 3 && parts.every((p) => p.length <= 28) ? parts : null;
}

const PITCH_ROWS: { key: keyof DocsContent; title: string }[] = [
  { key: 'market', title: 'Who it serves' },
  { key: 'businessModel', title: 'Business model' },
  { key: 'traction', title: 'Evidence' },
  { key: 'roadmap', title: 'Roadmap' },
  { key: 'ask', title: 'The ask' },
];

function Unavailable() {
  return (
    <main className="dx-page relative grid min-h-screen place-items-center overflow-hidden bg-canvas px-6 text-ink">
      <div aria-hidden className="dx-wash opacity-70" />
      <div className="relative flex max-w-md flex-col items-center text-center">
        <SourceLockup href="/" />
        <h1 className="mt-10 text-4xl font-semibold tracking-[-0.03em]">The docs aren&apos;t published yet.</h1>
        <p className="mt-4 text-ink/70">An admin can publish them from Settings → Docs publishing.</p>
        <Link href="/" className="mt-8 rounded-full bg-brand px-6 py-3 text-sm font-medium text-on-brand">
          Go to Orqestra
        </Link>
      </div>
    </main>
  );
}

export default async function DocsPage() {
  const org = await getCentralDocsOrg();
  if (!org) return <Unavailable />;
  const site = await db.docsSite.findUnique({ where: { orgId: org.id } });
  if (!site || !isPublished(site)) return <Unavailable />;
  const [live, content, team] = await Promise.all([
    getLiveDocsData(org.id),
    Promise.resolve(readContent(site.content)),
    Promise.resolve(readTeam(site.team)),
  ]);

  const metrics = [
    ['Team users', live.users],
    ['Job postings', live.postings],
    ['Applications', live.opportunities],
    ['Interviews', live.interviews],
    ['Activity events', live.events],
    ['Attendance records', live.attendance],
    ['Leave requests', live.leaveRequests],
    ['Agent runs', live.agentRuns],
  ] as const;
  const features = Object.entries(live.features).map(([key, on]) => ({
    label: key === 'ai' ? 'AI provider' : key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    on,
  }));
  const chips = stackChips(content.stack);

  return (
    <div className="dx-page dx-main min-h-screen bg-canvas pb-24 text-sm text-ink lg:pb-0">
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
      <DocsNav />
      {/* Phones: the logo above the hero (the sidebar is desktop only). */}
      <div className="flex items-center justify-between px-6 pt-5 lg:hidden">
        <SourceLockup href="/" />
        <Link href="/login" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">
          Open Orqestra
        </Link>
      </div>

      <main>
        {/* Overview */}
        <section id="overview" className="relative overflow-hidden">
          <div aria-hidden className="dx-wash" />
          <div aria-hidden className="dx-grid" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-6 pb-16 pt-10 lg:grid-cols-[1.15fr_0.85fr] lg:pb-20 lg:pt-14">
            <div>
              <span className="dx-in inline-flex items-center gap-2 rounded-full bg-canvas/80 px-2.5 py-1 text-2xs font-medium shadow-[0_0_0_1px_var(--color-line)] backdrop-blur" style={{ '--i': 0 } as React.CSSProperties}>
                <Sparkles size={13} className="text-brand" />
                {org.name} · product documentation
              </span>
              <h1 className="dx-in mt-5 text-3xl font-semibold leading-[1.08] md:text-4xl" style={{ '--i': 1 } as React.CSSProperties}>
                {content.headline}
              </h1>
              <p className="dx-in mt-4 max-w-xl text-md leading-relaxed" style={{ '--i': 2 } as React.CSSProperties}>
                {content.elevatorPitch}
              </p>
              <p className="dx-in mt-2 max-w-xl text-sm leading-relaxed text-ink/70" style={{ '--i': 3 } as React.CSSProperties}>
                {content.summary}
              </p>
              <div className="dx-in mt-7 flex flex-wrap gap-2" style={{ '--i': 4 } as React.CSSProperties}>
                <a href="#pitch" className="group inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand transition-transform active:scale-[0.97]">
                  Explore the product
                  <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </a>
                <a href="#technical" className="rounded-full bg-surface px-5 py-2.5 text-sm font-medium shadow-[0_0_0_1px_var(--color-line)] transition-transform active:scale-[0.97]">
                  Technical docs
                </a>
              </div>
            </div>

            {/* The one hero metric: live, straight from the database. */}
            <aside className="dx-in rounded-[20px] bg-canvas/90 p-6 shadow-[0_0_0_1px_var(--color-line),0_30px_70px_-40px_rgb(15_61_52/0.55)] backdrop-blur" style={{ '--i': 3 } as React.CSSProperties}>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <span className="dx-pulse size-2 rounded-full bg-positive text-positive" />
                  Live workspace
                </span>
                <span className="text-xs text-ink/60">{utc(live.asOf)}</span>
              </div>
              <div className="mt-6">
                <CountUp value={live.opportunities} className="block text-5xl font-semibold" />
                <p className="mt-1 text-sm">applications in the pipeline</p>
              </div>
              <dl className="mt-6 divide-y divide-line border-t border-line text-sm">
                {(
                  [
                    ['Job postings', live.postings],
                    ['Interviews', live.interviews],
                    ['Agent runs', live.agentRuns],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-3">
                    <dt>{label}</dt>
                    <dd className="font-medium">
                      <CountUp value={value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
        </section>

        {/* Pitch */}
        <section id="pitch" className="dx-reveal mx-auto max-w-6xl px-6 py-16">
          <Heading title="The case for Orqestra" />

          {/* One focal block: today versus with Orqestra. */}
          <div className="relative grid overflow-hidden rounded-[20px] shadow-[0_0_0_1px_var(--color-line)] md:grid-cols-2">
            <div className="bg-surface p-7 md:p-10">
              <p className="text-xs font-medium text-ink/60">Today</p>
              <p className="mt-4 max-w-md whitespace-pre-wrap text-lg font-medium leading-snug text-ink/80">{content.problem}</p>
            </div>
            <div className="dx-pitch-win relative bg-brand p-7 text-on-brand md:p-10">
              <p className="text-xs font-medium text-on-brand/70">With Orqestra</p>
              <p className="relative mt-4 max-w-md whitespace-pre-wrap text-lg font-medium leading-snug">{content.solution}</p>
            </div>
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 hidden size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-canvas text-brand shadow-[0_0_0_6px_var(--color-surface),0_8px_24px_-8px_rgb(15_61_52/0.5)] md:grid"
            >
              <ArrowRight size={18} />
            </span>
          </div>

          {/* The rest as a quiet list: title left, text right, hairlines between. */}
          <dl className="mt-10 border-b border-line">
            {PITCH_ROWS.map(({ key, title }) => (
              <div key={key} className="dx-row group grid gap-1 border-t border-line py-5 md:grid-cols-[220px_1fr] md:gap-8">
                <dt className="flex items-center gap-3 font-medium transition-colors duration-150 group-hover:text-brand">
                  <span aria-hidden className="dx-row-bar h-4 w-[3px] rounded-full bg-brand" />
                  {title}
                </dt>
                <dd className="max-w-2xl whitespace-pre-wrap leading-relaxed">{content[key]}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Live view */}
        <section id="live" className="bg-surface">
          <div className="dx-reveal mx-auto max-w-6xl px-6 py-16">
            <Heading
              title="Current workspace activity"
              aside={
                <>
                  <p>Counted from application records, {utc(live.asOf)}.</p>
                  <p className="text-ink/60">Operational activity, not customer or revenue claims.</p>
                </>
              }
            />
            <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
              <div className="rounded-[20px] bg-canvas p-2 shadow-[0_0_0_1px_var(--color-line)]">
                <dl className="grid sm:grid-cols-2">
                  {metrics.map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-4 rounded-2xl px-4 py-3.5 transition-colors duration-150 hover:bg-muted">
                      <dt className="text-sm">{label}</dt>
                      <dd className="text-xl font-semibold">
                        <CountUp value={value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="rounded-[20px] bg-canvas p-5 shadow-[0_0_0_1px_var(--color-line)]">
                <h3 className="text-md font-semibold">Configuration</h3>
                <ul className="mt-4 space-y-2">
                  {features.map((f) => (
                    <li key={f.label} className="flex items-center justify-between text-sm">
                      <span>{f.label}</span>
                      <span className={f.on ? 'rounded-full bg-brand px-3 py-1 text-xs font-medium text-on-brand' : 'rounded-full bg-muted px-3 py-1 text-xs font-medium'}>
                        {f.on ? 'On' : 'Off'}
                      </span>
                    </li>
                  ))}
                </ul>
                <dl className="mt-6 divide-y divide-line border-t border-line text-sm">
                  <div className="flex justify-between py-3">
                    <dt>API keys</dt>
                    <dd className="font-medium">{live.apiKeys}</dd>
                  </div>
                  <div className="flex justify-between py-3">
                    <dt>Webhook endpoints</dt>
                    <dd className="font-medium">{live.webhooks}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt>Latest activity</dt>
                    <dd className="text-right font-medium">{live.latestEventAt ? utc(live.latestEventAt) : 'None yet'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        {/* Team */}
        <section id="team" className="dx-reveal mx-auto max-w-6xl px-6 py-16">
          <Heading title="People behind the product" />
          {team.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {team.map((member) => (
                <article key={member.id} className="dx-card flex items-center gap-4 rounded-[20px] bg-surface p-5">
                  <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-full bg-brand text-lg font-semibold text-on-brand">
                    {member.image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- admin-supplied URL of any host
                      <img src={member.image} alt="" className="size-full object-cover" />
                    ) : (
                      member.name.slice(0, 1)
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-md font-semibold">{member.name}</h3>
                    <p className="text-xs">{member.role}</p>
                    {member.email ? (
                      <a className="mt-0.5 block truncate text-xs text-brand underline-offset-4 hover:underline" href={`mailto:${member.email}`}>
                        {member.email}
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-4 rounded-[20px] bg-surface p-6">
              <IconDot icon={Users} />
              <p>Team profiles will appear here when they are published.</p>
            </div>
          )}
        </section>

        {/* Technical */}
        <section id="technical" className="bg-surface">
          <div className="dx-reveal mx-auto max-w-6xl px-6 py-16">
            <Heading title="How the system works" />
            <div className="space-y-4">
              <article className="rounded-[20px] bg-muted p-5 md:p-6">
                <h3 className="mb-4 text-md font-semibold">Architecture</h3>
                <FlowDiagram
                  label="Architecture"
                  nodes={[
                    { icon: Monitor, text: 'Browser and candidate portal' },
                    { icon: Server, text: 'Next.js application' },
                    { icon: Workflow, text: 'Server actions and APIs' },
                    { icon: Database, text: 'PostgreSQL and integrations' },
                  ]}
                />
                <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed">{content.architecture}</p>
              </article>
              <article className="rounded-[20px] bg-muted p-5 md:p-6">
                <h3 className="mb-4 text-md font-semibold">Data flow</h3>
                <FlowDiagram
                  label="Data flow"
                  nodes={[
                    { icon: FileText, text: 'Job posted' },
                    { icon: Inbox, text: 'Application received' },
                    { icon: MessagesSquare, text: 'Interview and feedback' },
                    { icon: BadgeCheck, text: 'Hiring decision' },
                    { icon: Users, text: 'Employee operations' },
                  ]}
                />
                <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed">{content.dataFlow}</p>
              </article>
              <article className="rounded-[20px] bg-muted p-5 md:p-6">
                <h3 className="text-md font-semibold">Technology stack</h3>
                {chips ? (
                  <>
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {chips.map((c) => (
                        <li key={c} className="rounded-full bg-canvas px-3 py-1.5 text-xs font-medium shadow-[0_0_0_1px_var(--color-line)]">
                          {c}
                        </li>
                      ))}
                    </ul>
                    {content.stack.split(/\.\s+/).slice(1).join('. ').trim() ? (
                      <p className="mt-3 max-w-3xl text-sm leading-relaxed">{content.stack.split(/\.\s+/).slice(1).join('. ')}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed">{content.stack}</p>
                )}
              </article>
            </div>
          </div>
        </section>

        {/* API */}
        <section id="api" className="dx-reveal mx-auto max-w-6xl px-6 py-16">
          <Heading title="API surface" aside={<p>Every route needs an API key with the right permissions.</p>} />
          <div className="overflow-hidden rounded-[20px] bg-canvas shadow-[0_0_0_1px_var(--color-line)]">
            <ul className="divide-y divide-line">
              {publicApi.map((api) => (
                <li
                  key={api.path}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors duration-150 hover:bg-surface md:grid-cols-[7rem_1fr_14rem_auto] md:px-7"
                >
                  <span className="flex gap-1.5">
                    {api.method.split('/').map((m) => (
                      <span
                        key={m}
                        className={m === 'GET' ? 'rounded-md bg-recessed px-2 py-0.5 font-mono text-xs font-medium text-brand' : 'rounded-md bg-brand px-2 py-0.5 font-mono text-xs font-medium text-on-brand'}
                      >
                        {m}
                      </span>
                    ))}
                  </span>
                  <code className="min-w-0 break-all font-mono text-xs">{api.path}</code>
                  <span className="col-start-2 row-start-2 text-xs md:col-start-3 md:row-start-1">{api.purpose}</span>
                  <span className="col-start-3 row-start-1 md:col-start-4">
                    <CopyRoute text={api.path} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs">
            <Braces size={16} className="text-brand" />
            <span>
              Full reference in the repository: <code className="font-mono">docs/05-api-design.md</code>
            </span>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <SourceLockup href="/" />
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/help" className="hover:text-brand">Guide</Link>
            <Link href="/jobs" className="hover:text-brand">Find jobs</Link>
            <Link href="/login" className="hover:text-brand">Sign in</Link>
            <a href="#overview" className="hover:text-brand">Back to top</a>
          </nav>
          <p className="text-xs">Open source · Agents report, people decide.</p>
        </div>
      </footer>
    </div>
  );
}
