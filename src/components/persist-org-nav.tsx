'use client';

import { useEffect } from 'react';
import { persistOrgNavAction } from '@/app/(app)/org-nav-cookie';

/** Writes the shell cookie so later sidebar clicks skip the org round-trip. */
export function PersistOrgNav({
  name,
  logoFileId,
  onboardedAt,
}: {
  name: string;
  logoFileId: string | null;
  onboardedAt: string | null;
}) {
  useEffect(() => {
    void persistOrgNavAction({ name, logoFileId, onboardedAt });
  }, [name, logoFileId, onboardedAt]);

  return null;
}
