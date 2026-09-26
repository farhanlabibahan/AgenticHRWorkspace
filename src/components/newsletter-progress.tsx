'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Refreshes the page every few seconds while a newsletter is still going out. */
export function RefreshWhileSending({ sending }: { sending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(t);
  }, [sending, router]);
  return null;
}
