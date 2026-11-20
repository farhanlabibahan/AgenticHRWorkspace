'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { isAdmin, requireSession } from '@/lib/session';
import { DOC_KEYS, defaultContent, readContent, readTeam, type DocsContent } from '@/lib/docs-site';

function parseDate(value: unknown): Date | null {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string') throw new Error('Invalid date');
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('Invalid date');
  return date;
}

export async function saveDocsAction(input: {
  enabled: boolean; startsAt: string; endsAt: string; content: DocsContent;
  team: { id: string; name: string; role: string; email: string; image: string }[];
}) {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) throw new Error('Only admins can edit documentation');
  const startsAt = parseDate(input.startsAt);
  const endsAt = parseDate(input.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error('End time must follow start time');
  const content = readContent(input.content);
  for (const key of DOC_KEYS) if (content[key].length > 10000) throw new Error(`${key} is too long`);
  const team = readTeam(input.team).map((member) => ({
    id: member.id.slice(0, 100), name: member.name.trim().slice(0, 120),
    role: member.role.trim().slice(0, 120), email: member.email.trim().slice(0, 254),
    image: member.image.startsWith('data:image/jpeg;base64,') && member.image.length < 300000 ? member.image : '',
  }));
  await db.docsSite.upsert({
    where: { orgId: ctx.orgId },
    create: { orgId: ctx.orgId, enabled: input.enabled, startsAt, endsAt, content, team },
    update: { enabled: input.enabled, startsAt, endsAt, content, team },
  });
  revalidatePath('/docs');
  revalidatePath('/settings/docs');
  return { ok: true };
}

export async function createDocsDraftAction() {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) throw new Error('Only admins can edit documentation');
  return db.docsSite.upsert({
    where: { orgId: ctx.orgId },
    create: { orgId: ctx.orgId, enabled: false, content: defaultContent, team: [] },
    update: {},
  });
}
