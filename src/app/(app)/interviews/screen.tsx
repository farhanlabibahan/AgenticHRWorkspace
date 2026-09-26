import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { loadInterviewsPage } from '@/app/(app)/page-loaders';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { LocalTime } from '@/components/local-time';
import { NotetakerSuggestions } from '@/components/notetaker-suggestions';
import { surface } from '@/components/form-controls';
import { Avatar } from '@/components/ui/orb';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';

const STATE_TONES: Record<string, Tone> = {
  SCHEDULED: 'neutral',
  COMPLETED: 'positive',
  CANCELED: 'critical',
};

const sentence = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ');

export function InterviewsScreen({ data }: { data: Awaited<ReturnType<typeof loadInterviewsPage>> }) {
  const { upcoming, past, suggested } = data;

  const renderRow = (iv: (typeof upcoming)[number]) => (
    <Link
      key={iv.id}
      href={`/interviews/${iv.id}`}
      title="Open interview kit"
      className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 transition-colors duration-[120ms] hover:bg-muted/60"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={iv.contactName} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {iv.contactName}
            <span className="ml-2 font-normal text-ink-2">{iv.title}</span>
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-2">
            {iv.postingTitle ?? 'General'}
            {iv.panelistNames.length ? ` · with ${iv.panelistNames.join(', ')}` : ''}
            {iv.location ? ` · ${iv.location}` : ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs tabular-nums text-ink-2">
          <LocalTime date={iv.startAt} />
        </span>
        <Badge tone={STATE_TONES[iv.state] ?? 'neutral'}>{sentence(iv.state)}</Badge>
      </div>
    </Link>
  );

  return (
    <div className="t-reveal">
      <PageHeader title="Interviews" subtitle="Schedules, panels, and outcomes" />

      {upcoming.length === 0 && past.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No interviews yet"
          description="Schedule interviews from any candidate profile — they'll all show up here."
        />
      ) : (
        <div className="mx-6 mt-4 flex flex-col gap-8 pb-8">
          <NotetakerSuggestions meetings={suggested} />
          <section>
            <SectionHeader title="Upcoming" />
            {upcoming.length ? (
              <div className={`${surface} divide-y divide-line overflow-hidden`}>
                {upcoming.map(renderRow)}
              </div>
            ) : (
              <p className="text-sm text-ink-2">Nothing scheduled.</p>
            )}
          </section>
          {past.length ? (
            <section>
              <SectionHeader title="Recent" />
              <div className={`${surface} divide-y divide-line overflow-hidden`}>
                {past.map(renderRow)}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
