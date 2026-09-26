import type { LucideIcon } from 'lucide-react';
import { Orb } from '@/components/ui/orb';

/**
 * Empty state (docs/09 §8): a focal orb, a title, one quiet line — centered
 * on the canvas, no dashed box. The icon rides inside the orb. Its lines
 * rise in with a 40ms stagger (transitions.dev "texts reveal").
 */
const rise = (i: number) => ({ '--i': i }) as React.CSSProperties;

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-6 mt-4 flex flex-col items-center justify-center px-6 py-20 text-center">
      <span className="t-rise" style={rise(0)}>
        <Orb seed={title} size={96}>
          <Icon size={20} strokeWidth={1.75} className="text-ink/70" />
        </Orb>
      </span>
      <h2 className="t-rise mt-6 text-md font-medium text-ink" style={rise(1)}>
        {title}
      </h2>
      <p className="t-rise mt-1 max-w-sm text-sm text-ink-2" style={rise(2)}>
        {description}
      </p>
      {action ? (
        <div className="t-rise mt-5" style={rise(3)}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
