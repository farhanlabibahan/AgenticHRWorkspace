import Link from 'next/link';
import { Kanban, Plus } from 'lucide-react';
import type { loadPipelinePage } from '@/app/(app)/page-loaders';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { PipelineFilters } from '@/components/pipeline-filters';
import { PipelineList } from '@/components/pipeline-list';
import { PipelineNavProvider } from '@/components/pipeline-nav';
import { btnPrimary } from '@/components/form-controls';

export function PipelineScreen({ data }: { data: Awaited<ReturnType<typeof loadPipelinePage>> }) {
  const listInput = {
    posting: data.postingFilter,
    client: data.clientFilter,
    stage: data.stageFilter,
    q: data.q,
    status: data.archived ? 'archived' : '',
    sort: data.sort,
  };

  // No key on the list: a filter change updates it in place (focus stays on
  // the tile that was clicked); it resets its own selection and loaded pages.
  return (
    <PipelineNavProvider listInput={listInput}>
      <div className="t-reveal flex h-screen flex-col">
        <div className="flex items-start justify-between pr-6">
          <PageHeader title="Pipeline" />
          <div className="mt-6 flex items-center gap-2">
            <PipelineFilters postingGroups={data.postingGroups} clients={data.clients} />
            <Link href="/contacts/new" className={btnPrimary}>
              <Plus /> Add candidate
            </Link>
          </div>
        </div>

        {data.empty ? (
          <EmptyState
            icon={Kanban}
            title="Pipeline is empty"
            description="Add a candidate to see them move through your hiring stages."
          />
        ) : (
          <PipelineList
            stages={data.stages}
            counts={data.counts}
            page={data.page}
            after={data.after}
            postingGroups={data.postingGroups}
            clients={data.clients}
            archiveReasons={data.archiveReasons}
            fallbackGroupLabel={data.fallbackGroupLabel}
          />
        )}
      </div>
    </PipelineNavProvider>
  );
}
