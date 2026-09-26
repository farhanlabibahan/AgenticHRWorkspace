import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { PageHeader } from '@/components/page-header';
import { NewPostingForm } from '@/components/new-posting-form';

export default async function NewPostingPage() {
  const ctx = await requireSession();
  const org = await db.organization.findUnique({
    where: { id: ctx.orgId },
    include: {
      departments: { orderBy: { name: 'asc' } },
      clientCompanies: { orderBy: { name: 'asc' } },
    },
  });
  const isAgency = org?.kind === 'AGENCY';
  const groups = (isAgency ? org?.clientCompanies : org?.departments) ?? [];

  return (
    <div className="max-w-2xl">
      <PageHeader title="New posting" subtitle="Drafts are private until you publish" />
      <div className="mx-6 mb-8 mt-4 rounded-card bg-surface p-5">
        <NewPostingForm
          isAgency={isAgency}
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
        />
      </div>
    </div>
  );
}
