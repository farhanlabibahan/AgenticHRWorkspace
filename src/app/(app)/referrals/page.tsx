import { Suspense } from 'react';
import { loadReferralsPage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { ReferralsScreen } from './screen';

export const metadata = { title: 'Referrals — Orqestra' };

async function ReferralsContent() {
  return <ReferralsScreen data={await loadReferralsPage()} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function ReferralsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Referrals" subtitle="Submit people you know and track them through the pipeline" />}>
      <ReferralsContent />
    </Suspense>
  );
}
