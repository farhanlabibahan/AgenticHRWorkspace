import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { defaultContent, readContent, readTeam } from '@/lib/docs-site';
import { isAdmin, requireSession } from '@/lib/session';
import { DocsEditor } from './editor';

export const metadata = { title: 'Docs publishing — Orqestra' };

export default async function DocsSettingsPage() {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) redirect('/settings');
  const [org, site] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true } }),
    db.docsSite.findUnique({ where: { orgId: ctx.orgId } }),
  ]);
  return <DocsEditor orgSlug={org.slug} initial={{
    enabled: site?.enabled ?? false,
    startsAt: site?.startsAt?.toISOString() ?? null,
    endsAt: site?.endsAt?.toISOString() ?? null,
    content: site ? readContent(site.content) : defaultContent,
    team: site ? readTeam(site.team) : [],
  }} />;
}
