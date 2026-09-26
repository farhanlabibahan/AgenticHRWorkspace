import { CandidateProfile } from '@/components/candidate-profile';

// Intercepts in-app navigation to /candidates/[id]: the profile renders into
// the drawer from layout.tsx, over the list you came from, with loading.tsx
// as the skeleton while it streams. Direct loads use the full page.
export default async function CandidateModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CandidateProfile id={id} />;
}
