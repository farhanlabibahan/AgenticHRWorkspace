import { Suspense } from 'react';
import { loadContactsPage } from '@/app/(app)/page-loaders';
import { PageSkeleton } from '@/components/page-skeleton';
import { firstParams, type SearchParams } from '@/lib/utils';
import { ContactsScreen } from './screen';

export const metadata = { title: 'Contacts — Source' };

async function ContactsContent({ searchParams }: { searchParams: SearchParams }) {
  return <ContactsScreen data={await loadContactsPage(await firstParams(searchParams))} />;
}

// The header + skeleton stream immediately; the data follows in the same response.
export default function ContactsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageSkeleton title="Contacts" subtitle="Every person in your talent network" />}>
      <ContactsContent searchParams={searchParams} />
    </Suspense>
  );
}
