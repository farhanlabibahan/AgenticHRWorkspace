import { Suspense } from 'react';
import { loadPipelinePage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { firstParams, type SearchParams } from '@/lib/utils';
import { PipelineScreen } from './screen';

export const metadata = { title: 'Pipeline — Orqestra' };

async function PipelineContent({ searchParams }: { searchParams: SearchParams }) {
  return <PipelineScreen data={await loadPipelinePage(await firstParams(searchParams))} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function PipelinePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageSkeleton title="Pipeline" />}>
      <PipelineContent searchParams={searchParams} />
    </Suspense>
  );
}
