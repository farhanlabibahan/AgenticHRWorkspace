import { cache } from 'react';
import { unstable_cache, updateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export type SessionContext = {
  userId: string | null; // null when acting via API key
  orgId: string;
  accessRole: string;
  apiKeyId?: string;
};

export type OrgNav = {
  onboardedAt: Date | null;
  name: string;
  logoFileId: string | null;
};

export function isAdmin(ctx: SessionContext): boolean {
  return ctx.accessRole === 'SUPER_ADMIN' || ctx.accessRole === 'ADMIN';
}

/** Per-request dedupe — layout and pages both call this. */
export const getAuthSession = cache(async () => auth());

/** Resolve the signed-in user's tenant context, or redirect to login. */
export const requireSession = cache(async (): Promise<SessionContext> => {
  const session = await getAuthSession();
  if (!session?.user?.id || !session.user.orgId) redirect('/login');
  return {
    userId: session.user.id,
    orgId: session.user.orgId,
    accessRole: String(session.user.accessRole ?? 'TEAM_MEMBER'),
  };
});

/**
 * The signed-in user's tenant context, or null. For route handlers that
 * answer a signed-out caller with a 401 instead of a redirect to /login.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const session = await getAuthSession();
  if (!session?.user?.id || !session.user.orgId) return null;
  return {
    userId: session.user.id,
    orgId: session.user.orgId,
    accessRole: String(session.user.accessRole ?? 'TEAM_MEMBER'),
  };
});

function orgNavTag(orgId: string) {
  return `org-nav:${orgId}`;
}

/**
 * Sidebar + onboarding gate. Cached across navigations so the app shell
 * doesn't pay a Neon round-trip on every click. Invalidate via
 * `revalidateOrgNav` when name/logo/onboarding change.
 */
export const getOrgNav = cache(async (orgId: string): Promise<OrgNav | null> => {
  const row = await unstable_cache(
    async () =>
      db.organization.findUnique({
        where: { id: orgId },
        select: { onboardedAt: true, name: true, logoFileId: true },
      }),
    ['org-nav', orgId],
    { revalidate: 60, tags: [orgNavTag(orgId)] },
  )();
  if (!row) return null;
  return {
    name: row.name,
    logoFileId: row.logoFileId,
    // unstable_cache JSON-serializes Dates; coerce so callers can treat this as a Date.
    onboardedAt: row.onboardedAt ? new Date(row.onboardedAt) : null,
  };
});

/**
 * Server actions only. updateTag, not revalidateTag(…, 'max'): that one is
 * stale-while-revalidate, so the render right after "Finish setup" still saw
 * "not onboarded", bounced through /onboarding and lost where it was going.
 */
export function revalidateOrgNav(orgId: string) {
  updateTag(orgNavTag(orgId));
}
