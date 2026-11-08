import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { isAdmin, requireSession } from '@/lib/session';
import { getImportJob } from '@/server/imports/jobs';
import { ImportJob } from '@/components/imports/import-job';

/** One import's progress, stage review, and outcome. The client component keeps it moving. */
export const metadata = { title: 'Import — Orqestra' };

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  if (!isAdmin(ctx)) redirect('/settings');

  const { id } = await params;
  const job = await getImportJob(ctx, id);
  if (!job) notFound();

  return (
    <div>
      <div className="px-6 pt-6">
        <Link
          href="/settings/import"
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors duration-[120ms] hover:text-ink"
        >
          <ArrowLeft size={14} /> Imports
        </Link>
      </div>
      <ImportJob key={job.id} initial={job} />
    </div>
  );
}
