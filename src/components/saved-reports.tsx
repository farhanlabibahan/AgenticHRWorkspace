'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import { X } from 'lucide-react';
import { deleteSavedReportAction } from '@/app/(app)/actions';

export type SavedReportItem = { id: string; name: string; query: string };

export function SavedReports({ reports }: { reports: SavedReportItem[] }) {
  const [pending, startTransition] = useTransition();
  if (!reports.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {reports.map((r) => (
        <span
          key={r.id}
          className="inline-flex h-8 items-center gap-1 rounded-full bg-surface pl-3 pr-1 text-sm"
        >
          <Link href={`/reports/builder?${r.query}`} className="hover:underline underline-offset-2">
            {r.name}
          </Link>
          <button
            title="Delete saved report"
            aria-label="Delete saved report"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete saved report "${r.name}"?`)) return;
              startTransition(() => deleteSavedReportAction(r.id));
            }}
            className="flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-colors duration-[120ms] hover:bg-muted hover:text-critical disabled:opacity-40"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
