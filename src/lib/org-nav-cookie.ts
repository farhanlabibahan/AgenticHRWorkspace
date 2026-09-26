import { cookies } from 'next/headers';
import type { OrgNav } from '@/lib/session';

export const ORG_NAV_COOKIE = 'src-org-nav';

type OrgNavCookie = {
  name: string;
  logoFileId: string | null;
  onboardedAt: string | null;
};

export async function readOrgNavCookie(): Promise<OrgNav | null> {
  const raw = (await cookies()).get(ORG_NAV_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OrgNavCookie;
    if (!parsed || typeof parsed.name !== 'string') return null;
    return {
      name: parsed.name,
      logoFileId: parsed.logoFileId ?? null,
      onboardedAt: parsed.onboardedAt ? new Date(parsed.onboardedAt) : null,
    };
  } catch {
    return null;
  }
}

export async function writeOrgNavCookie(org: OrgNav) {
  (await cookies()).set(
    ORG_NAV_COOKIE,
    JSON.stringify({
      name: org.name,
      logoFileId: org.logoFileId,
      onboardedAt: org.onboardedAt ? org.onboardedAt.toISOString() : null,
    } satisfies OrgNavCookie),
    {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    },
  );
}
