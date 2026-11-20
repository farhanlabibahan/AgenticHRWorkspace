import { db } from '@/lib/db';
import { docsPasswordConfigured, hasDocsAdminAccess } from '@/lib/docs-admin';
import { defaultContent, getCentralDocsOrg, readContent, readTeam } from '@/lib/docs-site';
import { DocsEditor } from './editor';
import { lockDocsAction, unlockDocsAction } from './access-actions';

export const metadata = { title: 'Docs publishing — Orqestra' };
export const dynamic = 'force-dynamic';

export default async function DocsSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!(await hasDocsAdminAccess())) {
    const configured = docsPasswordConfigured();
    const { error } = await searchParams;
    return <main className="grid min-h-screen place-items-center bg-[#f7faf8] px-5 py-10 text-[#16382e]">
      <section className="w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[.18em] text-emerald-700">Orqestra · developer access</p>
        <h1 className="mt-3 text-3xl font-semibold">Documentation settings</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">Enter the documentation password to manage the central public page.</p>
        {configured ? <form action={unlockDocsAction} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">Password
            <input name="password" type="password" autoComplete="current-password" required autoFocus
              className="mt-2 block w-full rounded-lg border border-emerald-200 px-3 py-3 outline-none focus:border-emerald-700" />
          </label>
          {error === 'invalid' && <p role="alert" className="text-sm text-red-700">Incorrect password. Please try again.</p>}
          <button className="w-full rounded-lg bg-emerald-900 px-5 py-3 font-semibold text-white">Unlock settings</button>
        </form> : <p role="alert" className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">The documentation password is not configured on this deployment.</p>}
      </section>
    </main>;
  }
  const org = await getCentralDocsOrg();
  if (!org) return <main className="p-8 text-slate-700">Central documentation workspace is not configured.</main>;
  const site = await db.docsSite.findUnique({ where: { orgId: org.id } });
  return <div><div className="mx-auto flex max-w-5xl justify-end px-5 pt-5 sm:px-8"><form action={lockDocsAction}><button className="text-sm text-emerald-800 underline">Lock documentation settings</button></form></div><DocsEditor initial={{
    enabled: site?.enabled ?? false,
    startsAt: site?.startsAt?.toISOString() ?? null,
    endsAt: site?.endsAt?.toISOString() ?? null,
    content: site ? readContent(site.content) : defaultContent,
    team: site ? readTeam(site.team) : [],
  }} /></div>;
}
