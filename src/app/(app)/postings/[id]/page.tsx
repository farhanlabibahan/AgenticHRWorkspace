import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { PlanEditor } from '@/components/plan-editor';
import { ShareLinkButton } from '@/components/share-link-button';
import { sectionLabel, surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Orb } from '@/components/ui/orb';
import { Badge, type Tone } from '@/components/ui/primitives';
import { removePostingLogoAction, uploadPostingLogoAction } from '@/app/org-actions';
import { LogoUpload } from '@/components/logo-upload';
import { RoleOwner } from '@/components/role-owner';
import { MatchCriteriaEditor } from '@/components/match-criteria-editor';
import { cleanCriteria } from '@/lib/match-criteria';
import { aiConfigured } from '@/server/ai';

const STATE_BADGES: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'caution' },
  PUBLISHED: { label: 'Published', tone: 'positive' },
  INTERNAL: { label: 'Internal', tone: 'info' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

export default async function PostingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  const { id } = await params;
  const [posting, teammates] = await Promise.all([
    db.posting.findFirst({
    where: { id, orgId: ctx.orgId },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      department: true,
      clientCompany: true,
      requisition: true,
      planSteps: { orderBy: { order: 'asc' } },
      _count: { select: { opportunities: true } },
    },
    }),
    db.user.findMany({
      where: { orgId: ctx.orgId, deactivatedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    }),
  ]);
  if (!posting) notFound();
  const state = STATE_BADGES[posting.state] ?? { label: posting.state, tone: 'neutral' as Tone };
  const criteria = cleanCriteria(posting.matchCriteria);
  const aiOn = aiConfigured();

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <Link
        href="/postings"
        className={buttonClass({ variant: 'ghost', size: 'sm', className: '-ml-3 mb-4' })}
      >
        <ArrowLeft /> Postings
      </Link>

      <div className={`${surface} p-5`}>
        <div className="flex items-start justify-between gap-3">
          <Orb seed={posting.id} size={40} />
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <h1 className="mt-5 text-xl font-medium text-ink">{posting.title}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {[
            posting.clientCompany?.name ?? posting.department?.name,
            posting.location,
            `${posting._count.opportunities} candidate(s)`,
            posting.requisition ? `req ${posting.requisition.code}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-ink-2">Recruiter</span>
          <RoleOwner inline postingId={posting.id} owner={posting.owner} teammates={teammates} />
        </div>
        <div className="mt-6">
          <LogoUpload
            logoFileId={posting.logoFileId}
            upload={uploadPostingLogoAction.bind(null, posting.id)}
            remove={removePostingLogoAction.bind(null, posting.id)}
            label="Role logo"
          />
        </div>
        <div className="mt-6">
          <p className="mb-2 text-xs text-ink-2">
            Share progress with the hiring client — read-only, candidate names and stages only,
            no notes, scorecards, or compensation.
          </p>
          <div className="flex flex-wrap gap-2">
            <ShareLinkButton
              scope="posting"
              id={posting.id}
              subject={{ name: posting.title, detail: posting.location, seed: posting.id }}
            />
            {posting.clientCompanyId ? (
              <ShareLinkButton
                scope="client"
                id={posting.clientCompanyId}
                label={`All ${posting.clientCompany?.name} roles`}
                subject={{
                  name: posting.clientCompany?.name ?? 'Client',
                  detail: 'All roles',
                  seed: posting.clientCompanyId,
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      {aiOn ? (
        <section className="mt-8">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className={sectionLabel}>Match criteria</h2>
            <MatchCriteriaEditor
              postingId={posting.id}
              postingTitle={posting.title}
              criteria={criteria}
              aiEnabled={aiOn}
              label={criteria.length ? 'Edit criteria' : 'Add criteria'}
            />
          </div>
          <p className="mb-4 text-sm text-ink-2">
            What every candidate for this role is scored on; must-haves count double.
            {criteria.length ? null : ' With none set, the first evaluation drafts them from the job description.'}
          </p>
          {criteria.length ? (
            <div className="flex flex-wrap gap-1.5">
              {[...criteria.filter((c) => c.must), ...criteria.filter((c) => !c.must)].map((c) => (
                <Badge key={c.id} onCanvas className={c.must ? 'font-medium text-ink' : undefined}>
                  {c.label}
                  {c.must ? <span className="text-ink-3">must-have</span> : null}
                </Badge>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className={`${sectionLabel} mb-1`}>Interview plan</h2>
        <p className="mb-4 text-sm text-ink-2">
          The interview sequence this role expects. Scheduling from a step pre-fills the interview
          and carries its focus areas onto the interviewer kit.
        </p>
        <PlanEditor
          postingId={posting.id}
          steps={posting.planSteps.map((s) => ({
            id: s.id,
            title: s.title,
            durationMins: s.durationMins,
            focusAreas: s.focusAreas,
          }))}
        />
      </section>
    </div>
  );
}
