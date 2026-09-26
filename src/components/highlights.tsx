import { Building2, CalendarClock, Gauge, PenTool, Rocket, Star, TrendingUp, Users, type LucideIcon } from 'lucide-react';
import { surface } from '@/components/form-controls';
import { SectionHeader } from '@/components/ui/primitives';
import type { Highlight, HighlightKind } from '@/lib/highlights';

const ICON: Record<HighlightKind, LucideIcon> = {
  growth: TrendingUp,
  launch: Rocket,
  scale: Gauge,
  leadership: Users,
  range: Building2,
  craft: PenTool,
  tenure: CalendarClock,
  other: Star,
};

/** A few short signals about the candidate's path, one per row (src/lib/highlights.ts). */
export function HighlightsSection({ highlights }: { highlights: Highlight[] }) {
  if (!highlights.length) return null;
  return (
    <section>
      <SectionHeader title="Highlights" />
      <ul className="flex flex-col gap-2">
        {highlights.map((h) => {
          const Icon = ICON[h.kind];
          return (
            <li key={h.text} className={`${surface} flex items-center gap-2.5 px-4 py-3 text-sm text-ink`}>
              <Icon size={15} aria-hidden className="shrink-0 text-ink-2" />
              {h.text}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
