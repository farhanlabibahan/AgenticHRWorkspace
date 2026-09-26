import { PageHeader } from '@/components/page-header';
import { Skel, SkeletonWave } from '@/components/ui/skeleton';

// Enough rows to run off the bottom of any screen, each a little different.
const ROWS: [string, string, string][] = [
  ['w-40', 'w-24', 'w-24'],
  ['w-32', 'w-36', 'w-20'],
  ['w-48', 'w-28', 'w-28'],
  ['w-36', 'w-20', 'w-24'],
  ['w-44', 'w-32', 'w-16'],
  ['w-28', 'w-24', 'w-28'],
  ['w-40', 'w-36', 'w-20'],
  ['w-36', 'w-28', 'w-24'],
  ['w-32', 'w-20', 'w-28'],
  ['w-44', 'w-32', 'w-20'],
  ['w-40', 'w-24', 'w-24'],
  ['w-28', 'w-36', 'w-16'],
  ['w-48', 'w-28', 'w-28'],
  ['w-36', 'w-24', 'w-20'],
  ['w-32', 'w-32', 'w-24'],
  ['w-40', 'w-20', 'w-28'],
];

/**
 * Instant chrome while a sidebar page loads its data: the header, then list
 * rows filled like the real ones (avatar, name and detail, a stage pill, a
 * date), a light band sweeping across them, fading off toward the bottom.
 */
export function PageSkeleton({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <SkeletonWave className="mx-6 mt-4 h-[calc(100dvh-160px)] overflow-hidden pb-10">
        <div className="divide-y divide-line rounded-card bg-surface">
          {ROWS.map(([name, detail, pill], i) => (
            <div key={i} className="flex h-14 items-center gap-3 px-4">
              <Skel className="size-7 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skel className={`h-2.5 rounded-full ${name}`} />
                <Skel className={`h-2 rounded-full ${detail}`} />
              </div>
              <Skel className={`hidden h-6 rounded-full sm:block ${pill}`} />
              <Skel className="hidden h-2.5 w-16 rounded-full md:block" />
            </div>
          ))}
        </div>
      </SkeletonWave>
    </div>
  );
}
