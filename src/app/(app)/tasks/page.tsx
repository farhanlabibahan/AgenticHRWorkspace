import { Suspense } from 'react';
import { loadTasksPage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { TasksScreen } from './screen';

export const metadata = { title: 'Tasks — Source' };

async function TasksContent() {
  return <TasksScreen data={await loadTasksPage()} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function TasksPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Tasks" subtitle="To-dos and snoozed candidates across the team" />}>
      <TasksContent />
    </Suspense>
  );
}
