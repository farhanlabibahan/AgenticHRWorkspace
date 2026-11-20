import Link from 'next/link';
import { db } from '@/lib/db';
import { getLiveDocsData, isPublished, publicApi, readContent, readTeam } from '@/lib/docs-site';
import { getSessionContext } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documentation — Orqestra', description: 'Product overview and technical documentation' };

const pitchKeys = [
  ['problem', 'The problem'], ['solution', 'The solution'], ['market', 'Who it serves'],
  ['businessModel', 'Business model'], ['traction', 'Evidence'], ['roadmap', 'Roadmap'], ['ask', 'The ask'],
] as const;

function Diagram({ kind }: { kind: 'architecture' | 'flow' }) {
  const nodes = kind === 'architecture'
    ? ['Browser and candidate portal', 'Next.js application', 'Server actions and APIs', 'PostgreSQL and integrations']
    : ['Job posted', 'Application received', 'Interview and feedback', 'Hiring decision', 'Employee operations'];
  return <div role="img" aria-label={`${kind} diagram: ${nodes.join(' to ')}`} className="grid gap-2 sm:flex sm:items-stretch">
    {nodes.map((node, index) => <div key={node} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-0">
      <div className="flex min-h-20 flex-1 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center text-sm font-medium text-emerald-950">{node}</div>
      {index < nodes.length - 1 && <span aria-hidden="true" className="px-1 text-emerald-600 sm:px-2">→</span>}
    </div>)}
  </div>;
}

function Unavailable() {
  return <main className="grid min-h-screen place-items-center bg-[#f7faf8] px-5"><div className="max-w-md rounded-2xl border border-emerald-100 bg-white p-10 text-center shadow-sm"><p className="text-sm font-semibold uppercase tracking-[.2em] text-emerald-700">Orqestra Docs</p><h1 className="mt-4 text-3xl font-semibold text-emerald-950">Not Available</h1><p className="mt-3 text-gray-600">This documentation is not currently published.</p></div></main>;
}

export default async function DocsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: slug } = await searchParams;
  const org = slug
    ? await db.organization.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } })
    : await (async () => {
        const ctx = await getSessionContext();
        if (ctx) return db.organization.findUnique({ where: { id: ctx.orgId }, select: { id: true, name: true, slug: true } });
        const organizations = await db.organization.findMany({ take: 2, select: { id: true, name: true, slug: true } });
        return organizations.length === 1 ? organizations[0] : null;
      })();
  if (!org) return <Unavailable />;
  const site = await db.docsSite.findUnique({ where: { orgId: org.id } });
  if (!site || !isPublished(site)) return <Unavailable />;
  const [live, content, team] = await Promise.all([
    getLiveDocsData(org.id), Promise.resolve(readContent(site.content)), Promise.resolve(readTeam(site.team)),
  ]);
  const metrics = [
    ['Team users', live.users], ['Job postings', live.postings], ['Applications', live.opportunities],
    ['Interviews', live.interviews], ['Activity events', live.events], ['Attendance records', live.attendance],
    ['Leave requests', live.leaveRequests], ['AI executions', live.agentRuns],
  ] as const;
  return <main className="min-h-screen bg-[#f7faf8] text-[#16382e]">
    <header className="sticky top-0 z-10 border-b border-emerald-100 bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4"><Link href="#top" className="text-xl font-bold tracking-tight">Orqestra <span className="font-normal text-emerald-600">/ docs</span></Link><nav aria-label="Documentation sections" className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><a href="#pitch">Pitch</a><a href="#live">Live view</a><a href="#team">Team</a><a href="#technical">Technical</a><a href="#api">APIs</a></nav></div></header>
    <div id="top" className="mx-auto max-w-6xl px-5 pb-20">
      <section className="py-16 sm:py-24"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">{org.name} · product overview</p><h1 className="mt-5 max-w-4xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{content.headline}</h1><p className="mt-7 max-w-3xl text-xl leading-relaxed text-slate-700">{content.elevatorPitch}</p><p className="mt-5 max-w-3xl leading-relaxed text-slate-600">{content.summary}</p><div className="mt-8 flex flex-wrap gap-3"><a href="#pitch" className="rounded-xl bg-emerald-900 px-5 py-3 text-sm font-semibold text-white">Explore the product</a><a href="#technical" className="rounded-xl border border-emerald-300 px-5 py-3 text-sm font-semibold">View technical docs</a></div></section>
      <section id="pitch" className="scroll-mt-24"><div className="mb-6"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">01 / Pitch deck</p><h2 className="mt-2 text-3xl font-semibold">The case for Orqestra</h2></div><div className="grid gap-4 md:grid-cols-2">{pitchKeys.map(([key, title], index) => <article key={key} className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm"><p className="text-xs font-bold uppercase tracking-widest text-emerald-600">{String(index + 1).padStart(2, '0')}</p><h3 className="mt-3 text-xl font-semibold">{title}</h3><p className="mt-3 whitespace-pre-wrap leading-relaxed text-slate-700">{content[key]}</p></article>)}</div></section>
      <section id="live" className="scroll-mt-24 py-16"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">02 / Live system view</p><h2 className="mt-2 text-3xl font-semibold">Current workspace activity</h2><p className="mt-2 text-sm text-slate-600">Aggregated directly from application records at {new Date(live.asOf).toLocaleString('en', { timeZone: 'UTC' })} UTC. Counts are operational activity, not customer or revenue claims.</p><div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">{metrics.map(([label, value]) => <div key={label} className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm"><div className="text-3xl font-semibold tabular-nums">{value.toLocaleString()}</div><div className="mt-2 text-sm text-slate-600">{label}</div></div>)}</div><div className="mt-5 rounded-2xl border border-emerald-100 bg-white p-6"><h3 className="font-semibold">Live configuration</h3><div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">{Object.entries(live.features).map(([key, value]) => <div key={key} className="rounded-lg bg-emerald-50 p-3"><span className="capitalize">{key.replace(/([A-Z])/g, ' $1')}</span><strong className="float-right">{value ? 'On' : 'Off'}</strong></div>)}</div><p className="mt-4 text-sm text-slate-600">Configured API keys: {live.apiKeys} · Webhook endpoints: {live.webhooks} · Latest activity: {live.latestEventAt ? new Date(live.latestEventAt).toLocaleString('en', { timeZone: 'UTC' }) + ' UTC' : 'None yet'}</p></div></section>
      <section id="team" className="scroll-mt-24"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">03 / Team</p><h2 className="mt-2 text-3xl font-semibold">People behind the product</h2>{team.length ? <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{team.map((member) => <article key={member.id} className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm"><div className="flex items-center gap-4"><div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 text-2xl font-semibold">{member.image ? <img src={member.image} alt="" className="h-full w-full object-cover" /> : member.name.slice(0, 1)}</div><div className="min-w-0"><h3 className="font-semibold">{member.name}</h3><p className="text-sm text-slate-600">{member.role}</p></div></div><a className="mt-4 block break-all text-sm text-emerald-800 underline" href={`mailto:${member.email}`}>{member.email}</a></article>)}</div> : <p className="mt-4 text-slate-600">Team profiles will appear here when published.</p>}</section>
      <section id="technical" className="scroll-mt-24 py-16"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">04 / Technical documentation</p><h2 className="mt-2 text-3xl font-semibold">How the system works</h2><div className="mt-6 space-y-5"><article className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm"><h3 className="mb-4 text-xl font-semibold">Architecture</h3><Diagram kind="architecture" /><p className="mt-5 whitespace-pre-wrap leading-relaxed text-slate-700">{content.architecture}</p></article><article className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm"><h3 className="mb-4 text-xl font-semibold">Data flow</h3><Diagram kind="flow" /><p className="mt-5 whitespace-pre-wrap leading-relaxed text-slate-700">{content.dataFlow}</p></article><article className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm"><h3 className="text-xl font-semibold">Technology stack</h3><p className="mt-3 whitespace-pre-wrap leading-relaxed text-slate-700">{content.stack}</p></article></div></section>
      <section id="api" className="scroll-mt-24"><p className="text-sm font-bold uppercase tracking-[.2em] text-emerald-700">05 / Developer interface</p><h2 className="mt-2 text-3xl font-semibold">API surface</h2><p className="mt-2 text-slate-600">These routes require the appropriate application credentials and permissions.</p><div className="mt-6 overflow-x-auto rounded-2xl border border-emerald-100 bg-white"><table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-emerald-50"><tr><th className="p-4">Method</th><th className="p-4">Route</th><th className="p-4">Purpose</th></tr></thead><tbody>{publicApi.map((api) => <tr key={api.path} className="border-t border-emerald-100"><td className="p-4 font-mono">{api.method}</td><td className="p-4 font-mono">{api.path}</td><td className="p-4">{api.purpose}</td></tr>)}</tbody></table></div></section>
    </div>
  </main>;
}
