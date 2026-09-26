'use client';

import { useEffect, useState } from 'react';

/**
 * Renders a timestamp in the VIEWER's timezone. Server components render
 * dates in the server's timezone — wrong for anyone not sitting next to
 * the deployment. Renders the UTC form first (matching the server) and
 * swaps to local time after hydration to avoid a mismatch warning.
 */
export function LocalTime({
  date,
  options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
}: {
  date: string;
  options?: Intl.DateTimeFormatOptions;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const d = new Date(date);
  return (
    <time dateTime={date} suppressHydrationWarning>
      {mounted ? d.toLocaleString(undefined, options) : d.toLocaleString('en-US', { ...options, timeZone: 'UTC' })}
    </time>
  );
}
