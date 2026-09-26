import { Suspense } from 'react';
import { CandidateProfile } from '@/components/candidate-profile';
import { DrawerContent } from '@/components/drawer-host';
import PipelinePage from '@/app/(app)/pipeline/page';

export const metadata = { title: 'Candidate — Source' };

/**
 * A candidate opened directly (a refresh, a shared link): the same drawer as
 * in-app navigation, over the pipeline. Closing it lands on the pipeline.
 */
export default async function CandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PipelinePage searchParams={Promise.resolve({})} />
      <DrawerContent standalone>
        {/* the drawer's own skeleton shows until the profile crossfades in */}
        <Suspense fallback={null}>
          <CandidateProfile id={id} />
        </Suspense>
      </DrawerContent>
    </>
  );
}
