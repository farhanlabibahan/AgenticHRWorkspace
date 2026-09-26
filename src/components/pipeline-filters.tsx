'use client';

import { useMemo } from 'react';
import { Dropdown } from '@/components/dropdown';
import { usePipelineNav } from '@/components/pipeline-nav';

export function PipelineFilters({
  postingGroups,
  clients,
}: {
  /** The rail's groups: the Posting dropdown lists the same postings, by title. */
  postingGroups: { label: string | null; postings: { id: string; title: string }[] }[];
  clients: { id: string; name: string }[];
}) {
  const nav = usePipelineNav();
  const postings = useMemo(
    () => postingGroups.flatMap((g) => g.postings).sort((a, b) => a.title.localeCompare(b.title)),
    [postingGroups],
  );

  return (
    <>
      {clients.length > 0 ? (
        <Dropdown
          label="Client"
          value={nav.input.client ?? ''}
          allLabel="All clients"
          options={clients.map((c) => ({ value: c.id, label: c.name }))}
          // A client change resets the posting.
          onSelect={(value) => nav.go({ client: value, posting: '' })}
        />
      ) : null}
      <Dropdown
        label="Posting"
        value={nav.input.posting ?? ''}
        allLabel="All postings"
        options={postings.map((p) => ({ value: p.id, label: p.title }))}
        onSelect={(value) => nav.go({ posting: value })}
      />
    </>
  );
}
