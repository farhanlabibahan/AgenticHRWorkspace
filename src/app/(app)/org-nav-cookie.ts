'use server';

import { writeOrgNavCookie } from '@/lib/org-nav-cookie';

export async function persistOrgNavAction(input: {
  name: string;
  logoFileId: string | null;
  onboardedAt: string | null;
}) {
  await writeOrgNavCookie({
    name: input.name,
    logoFileId: input.logoFileId,
    onboardedAt: input.onboardedAt ? new Date(input.onboardedAt) : null,
  });
}
