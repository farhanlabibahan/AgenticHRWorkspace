import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { defaultContent, getCentralDocsOrg, readContent, readTeam } from '@/lib/docs-site';
import { isAdmin, requireSession } from '@/lib/session';
import { DocsEditor } from './editor';

export const metadata = { title: 'Docs publishing — Orqestra' };

export default async function DocsSettingsPage() {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) redirect('/settings');
  const [org, site] = await Promise.all([
    getCentralDocsOrg(),
    db.docsSite.findUnique({ where: { orgId: ctx.orgId } }),
  ]);
  if (!org || org.id !== ctx.orgId) redirect('/settings');
  return <DocsEditor initial={{
    enabled: site?.enabled ?? false,
    startsAt: site?.startsAt?.toISOString() ?? null,
    endsAt: site?.endsAt?.toISOString() ?? null,
    content: site ? readContent(site.content) : defaultContent,
    team: site ? readTeam(site.team) : [],
  }} />;
}
