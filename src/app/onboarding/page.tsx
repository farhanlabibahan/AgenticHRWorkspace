import { redirect } from 'next/navigation';
import { SourceLockup } from '@/components/powered-by';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { completeOnboardingAction } from '@/app/org-actions';
import { OrgKindPicker } from '@/components/org-kind-picker';
import { GroupManager } from '@/components/group-manager';
import { OnboardingPipeline } from '@/components/onboarding-pipeline';
import { btnGhost, surface } from '@/components/form-controls';
import { signOut } from '@/lib/auth';

export const metadata = { title: 'Set up · Orqestra' };

async function signOutAction() {
  'use server';
  await signOut({ redirectTo: '/login' });
}

export default async function OnboardingPage() {
  const ctx = await requireSession();
  const org = await db.organization.findUnique({
    where: { id: ctx.orgId },
    include: {
      departments: { orderBy: { name: 'asc' } },
      clientCompanies: { orderBy: { name: 'asc' } },
      stages: { orderBy: { order: 'asc' } },
    },
  });
  if (!org) redirect('/login');
  if (org.onboardedAt) redirect('/pipeline');

  const isAgency = org.kind === 'AGENCY';

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between gap-4">
        <SourceLockup />
        {/* A way out: skip to the app with the defaults (all of it is in Settings later), or leave. */}
        <div className="flex items-center gap-1">
          <form action={completeOnboardingAction}>
            <button type="submit" className={btnGhost}>
              Skip for now
            </button>
          </form>
          <form action={signOutAction}>
            <button type="submit" className={btnGhost}>
              Sign out
            </button>
          </form>
        </div>
      </div>

      <h1 className="text-xl font-medium">Set up {org.name}</h1>
      <p className="mt-1 text-sm text-ink-2">
        A few choices to shape your workspace — everything here can be changed later in Settings.
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <section className={`${surface} p-5`}>
          <h2 className="mb-1 text-md font-medium">1 · Who are you hiring for?</h2>
          <p className="mb-4 text-sm text-ink-2">
            This shapes how postings are organized across the app.
          </p>
          <OrgKindPicker current={org.kind} />
        </section>

        <section className={`${surface} p-5`}>
          <h2 className="mb-1 text-md font-medium">
            2 · {isAgency ? 'Client companies' : 'Departments'}
          </h2>
          <p className="mb-4 text-sm text-ink-2">
            {isAgency
              ? 'Add the companies you hire for. Every posting can be tied to a client, and your pipeline can be filtered per client.'
              : 'Add your teams or departments (Engineering, Design, Sales…). Postings are grouped by department on your careers page.'}
          </p>
          <GroupManager
            kind={isAgency ? 'client' : 'department'}
            items={(isAgency ? org.clientCompanies : org.departments).map((g) => ({
              id: g.id,
              name: g.name,
            }))}
            placeholder={isAgency ? 'Acme Corp' : 'Engineering'}
          />
        </section>

        <OnboardingPipeline stages={org.stages.map((s) => ({ id: s.id, name: s.name, type: s.type }))} />
      </div>
    </div>
  );
}
