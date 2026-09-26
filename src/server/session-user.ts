import type { AccessRole } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * What a sign-in puts in the session, whichever way the person signed in
 * (password or Google): the jwt callback in lib/auth.config.ts copies these
 * fields into the token.
 */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  orgId: string;
  accessRole: AccessRole;
  orgName: string;
  orgLogoFileId: string | null;
  onboardedAt: string | null;
};

export function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  orgId: string;
  accessRole: AccessRole;
  org: { name: string; logoFileId: string | null; onboardedAt: Date | null };
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    orgId: user.orgId,
    accessRole: user.accessRole,
    orgName: user.org.name,
    orgLogoFileId: user.org.logoFileId,
    onboardedAt: user.org.onboardedAt?.toISOString() ?? null,
  };
}

export const sessionOrgSelect = { name: true, logoFileId: true, onboardedAt: true } as const;

/** The session for an active user, or null when they're deactivated or gone. */
export async function activeSessionUser(userId: string): Promise<SessionUser | null> {
  const user = await db.user.findFirst({
    where: { id: userId, deactivatedAt: null },
    include: { org: { select: sessionOrgSelect } },
  });
  return user ? toSessionUser(user) : null;
}
