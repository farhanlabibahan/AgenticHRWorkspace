import { Suspense } from 'react';
import { loadReviewPage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { firstParams, type SearchParams } from '@/lib/utils';
import { ReviewScreen } from './screen';

export const metadata = { title: 'Review — Orqestra' };

async function ReviewContent({ searchParams }: { searchParams: SearchParams }) {
  const { posting } = await firstParams(searchParams);
  return <ReviewScreen data={await loadReviewPage(posting ?? '')} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function ReviewPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageSkeleton title="Review" subtitle="New applications, evaluated against the role and ranked" />}>
      <ReviewContent searchParams={searchParams} />
    </Suspense>
  );
}
