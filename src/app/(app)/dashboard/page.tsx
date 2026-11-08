import { Suspense } from 'react';
import { loadDashboardPage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { DashboardScreen } from './screen';

export const metadata = { title: 'Dashboard — Orqestra' };

async function DashboardContent() {
  return <DashboardScreen data={await loadDashboardPage()} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function DashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Dashboard" />}>
      <DashboardContent />
    </Suspense>
  );
}
