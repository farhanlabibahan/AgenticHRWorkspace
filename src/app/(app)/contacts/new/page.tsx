import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { PageHeader } from '@/components/page-header';
import { NewCandidateForm } from '@/components/new-candidate-form';

export default async function NewCandidatePage() {
  const ctx = await requireSession();
  const [stages, postings] = await Promise.all([
    db.stage.findMany({ where: { orgId: ctx.orgId }, orderBy: { order: 'asc' } }),
    db.posting.findMany({
      where: { orgId: ctx.orgId, state: { not: 'CLOSED' } },
      orderBy: { title: 'asc' },
      include: { clientCompany: true },
    }),
  ]);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Add candidate"
        subtitle="Creates a contact and opens an opportunity in your pipeline"
      />
      <div className="mx-6 mb-8 mt-2 rounded-card bg-surface p-5">
        <NewCandidateForm
          stages={stages.map((s) => ({ id: s.id, name: s.name }))}
          postings={postings.map((p) => ({
            id: p.id,
            title: p.clientCompany ? `${p.title} — ${p.clientCompany.name}` : p.title,
          }))}
        />
      </div>
    </div>
  );
}
