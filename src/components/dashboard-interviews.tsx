'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { badge, sectionLabel, surface } from '@/components/form-controls';
import { Avatar } from '@/components/ui/orb';
import { buttonClass } from '@/components/ui/button';

type DashboardInterview = {
  id: string;
  title: string;
  startAt: string;
  durationMins: number;
  contactName: string;
  postingTitle: string | null;
  clientName: string | null;
  panelistNames: string[];
};

/**
 * Interviews grouped by the VIEWER's calendar day. Day boundaries depend on
 * the timezone, so like LocalTime this renders in UTC first (matching the
 * server HTML) and regroups in local time once hydrated.
 */
export function DashboardInterviews({ interviews }: { interviews: DashboardInterview[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const locale = mounted ? undefined : 'en-US';
  const timeZone = mounted ? undefined : 'UTC';

  if (interviews.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No interviews yet"
        description="Scheduled interviews appear here, grouped by day, with one-click access to their kits."
      />
    );
  }

  const groups = new Map<string, DashboardInterview[]>();
  for (const iv of interviews) {
    const day = new Date(iv.startAt).toLocaleDateString(locale, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(iv);
  }

  return (
    <div className="flex flex-col gap-8">
      {[...groups.entries()].map(([day, items]) => (
        <section key={day}>
          <h2 className={`${sectionLabel} mb-3`}>{day}</h2>
          <div className={`${surface} divide-y divide-line`}>
            {items.map((iv) => (
              <div key={iv.id} className="flex items-center gap-3 px-4 py-3.5">
                <Avatar name={iv.contactName} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {iv.contactName} — {iv.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-2">
                    {iv.postingTitle
                      ? `${iv.postingTitle}${iv.clientName ? ` · ${iv.clientName}` : ''}`
                      : 'General opportunity'}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className={badge}>
                      {new Date(iv.startAt).toLocaleTimeString(locale, {
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone,
                      })}
                      {' · '}
                      {iv.durationMins} min
                    </span>
                    {iv.panelistNames.length ? (
                      <span className="text-xs text-ink-2">{iv.panelistNames.join(', ')}</span>
                    ) : null}
                  </p>
                </div>
                <Link
                  href={`/interviews/${iv.id}`}
                  className={buttonClass({ variant: 'ghost', size: 'sm' })}
                >
                  View interview <span className="t-learn-arrow text-ink-3">→</span>
                </Link>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
