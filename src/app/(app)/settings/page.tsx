import Link from 'next/link';
import { db } from '@/lib/db';
import { isAdmin, requireSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StageManager } from '@/components/stage-manager';
import { GroupManager } from '@/components/group-manager';
import { TemplateManager } from '@/components/template-manager';
import { AutomationSettings } from '@/components/automation-settings';
import { TalentNetworkToggle } from '@/components/talent-network-toggle';
import { ApiKeysManager } from '@/components/api-keys-manager';
import { WebhooksManager } from '@/components/webhooks-manager';
import { ResumeParsingStatus } from '@/components/resume-parsing-status';
import { CsvImport } from '@/components/csv-import';
import { FeedbackVisibilityToggle } from '@/components/feedback-visibility-toggle';
import { TeamManager } from '@/components/team-manager';
import { CustomFieldsManager } from '@/components/custom-fields-manager';
import { EeoToggle } from '@/components/eeo-toggle';
import { PostingApprovalToggle } from '@/components/posting-approval-toggle';
import { SettingsSwitch } from '@/components/settings-switch';
import { NotetakerConnections } from '@/components/notetaker-connections';
import { myNotetakerConnections, orgNotetakerOverview, suggestedMeetingCount } from '@/server/notetakers/connections';
import { isDemoOrg } from '@/server/notetakers/sync';
import {
  addScorecardQuestionAction,
  archiveScorecardQuestionAction,
  removeOrgLogoAction,
  saveRetentionAction,
  setAutoScheduleOnInterviewStagesAction,
  setRequireOfferApprovalAction,
  uploadOrgLogoAction,
} from '@/app/org-actions';
import { LogoUpload } from '@/components/logo-upload';
import { BrandKitEditor } from '@/components/brand-kit-editor';
import { readBrand } from '@/lib/brand';
import { googleAuthEnabled } from '@/server/google-auth';
import { badge, btnPrimary, btnTonal, inputClass, selectClass, surface, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/primitives';

export const metadata = { title: 'Settings — Source' };

/** A settings group: a quiet label on the canvas above one white card of rows. */
function Group({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={id ? 'scroll-mt-16' : undefined}>
      <SectionHeader title={title} />
      <div className={`${surface} divide-y divide-line`}>{children}</div>
    </section>
  );
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4', className)}>{children}</div>;
}

/** Description on the left, its control on the right (stacks on mobile). */
function ControlRow({ description, children }: { description: React.ReactNode; children: React.ReactNode }) {
  return (
    <Row className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <p className="max-w-prose text-sm text-ink-2">{description}</p>
      <div className="shrink-0">{children}</div>
    </Row>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; notetaker?: string; provider?: string }>;
}) {
  const ctx = await requireSession();
  const { section = 'business', notetaker, provider: notetakerProviderId } = await searchParams;
  const notetakers =
    section === 'integrations'
      ? await Promise.all([
          myNotetakerConnections(ctx),
          isAdmin(ctx) ? orgNotetakerOverview(ctx) : Promise.resolve(null),
          isDemoOrg(ctx.orgId),
          suggestedMeetingCount(ctx),
        ])
      : null;

  const [org, members, stages, archiveReasons, templates, apiKeys, webhooks, fieldDefs, scorecardQuestions] = await Promise.all([
    db.organization.findUnique({
      where: { id: ctx.orgId },
      include: {
        departments: { orderBy: { name: 'asc' } },
        clientCompanies: { orderBy: { name: 'asc' } },
      },
    }),
    db.user.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, accessRole: true, deactivatedAt: true },
    }),
    db.stage.findMany({ where: { orgId: ctx.orgId }, orderBy: { order: 'asc' } }),
    db.archiveReason.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }),
    db.emailTemplate.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }),
    db.apiKey.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' } }),
    db.webhookEndpoint.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      include: { deliveries: { select: { success: true } } },
    }),
    db.customFieldDef.findMany({ where: { orgId: ctx.orgId }, orderBy: { label: 'asc' } }),
    db.scorecardQuestion.findMany({
      where: { orgId: ctx.orgId, archivedAt: null },
      orderBy: { order: 'asc' },
    }),
  ]);
  const isAgency = org?.kind === 'AGENCY';

  return (
    <div>
      <PageHeader title="Settings" subtitle="Organization, pipeline, and team" />

      <div className="mx-6 mt-4 flex gap-8 pb-8">
        <aside className="hidden w-52 shrink-0 md:block">
          {[
            {
              eyebrow: 'Personal',
              items: [
                ['integrations', 'Integrations'],
                ['email', 'Email'],
              ],
            },
            {
              eyebrow: 'Organization',
              items: [
                ['business', 'Business information'],
                ['hiring', 'Hiring'],
                ['team', 'Team'],
                ['data', 'Data & privacy'],
              ],
            },
          ].map((g) => (
            <div key={g.eyebrow} className="mb-6">
              <p className="mb-1.5 px-3 text-xs font-medium text-ink-2">{g.eyebrow}</p>
              <div className="flex flex-col gap-0.5">
                {g.items.map(([key, label]) => (
                  <a
                    key={key}
                    href={`/settings?section=${key}`}
                    aria-current={section === key ? 'page' : undefined}
                    className={`flex h-8 items-center rounded-full px-3 text-sm transition-colors duration-[120ms] ${
                      section === key ? 'bg-surface font-medium text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink'
                    }`}
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </aside>

      <div className="flex max-w-3xl min-w-0 flex-1 flex-col gap-8">
        {section === 'business' ? (
        <Group id="org" title="Organization">
          <Row>
            <div className="flex items-center gap-2">
              <p className="text-md font-medium text-ink">{org?.name}</p>
              <span className={badge}>{isAgency ? 'Staffing agency' : 'Company'}</span>
            </div>
            <p className="mt-1 text-sm text-ink-2">
              Careers page:{' '}
              <a
                href={`/careers/${org?.slug}`}
                target="_blank"
                className="font-mono text-xs text-ink underline underline-offset-2"
              >
                /careers/{org?.slug}
              </a>
            </p>
          </Row>
          <Row>
            <p className="mb-3 text-sm text-ink-2">
              Company logo — shown on your careers pages{isAgency ? ' (roles can override it with a client logo)' : ''}.
            </p>
            <LogoUpload
              logoFileId={org?.logoFileId ?? null}
              upload={uploadOrgLogoAction}
              remove={removeOrgLogoAction}
              label="Logo"
            />
          </Row>
        </Group>
        ) : null}

        {section === 'business' && isAdmin(ctx) && org ? (
        <Group title="Brand">
          <Row>
            <p className="mb-5 text-sm text-ink-2">
              How your job board, application form and emails to candidates look: your font, text size and colors, with your logo from above.
            </p>
            <BrandKitEditor initial={readBrand(org.brand)} logoFileId={org.logoFileId} orgName={org.name} />
          </Row>
        </Group>
        ) : null}

        {section === 'business' ? (
        <Group title={isAgency ? 'Client companies' : 'Departments'}>
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              {isAgency
                ? 'The companies you hire for. Postings attach to a client; the pipeline can be filtered per client.'
                : 'Teams you hire into. Postings are grouped by department on your careers page.'}
            </p>
            <GroupManager
              kind={isAgency ? 'client' : 'department'}
              items={((isAgency ? org?.clientCompanies : org?.departments) ?? []).map((g) => ({
                id: g.id,
                name: g.name,
              }))}
              placeholder={isAgency ? 'Acme Corp' : 'Engineering'}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group id="hiring" title="Pipeline stages">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Rename, reorder, add, or remove the stages every candidate moves through.
            </p>
            <StageManager
              stages={stages.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'email' ? (
        <Group id="email" title="Email templates">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Reusable emails with merge tokens — used for manual sends and automation.
            </p>
            <TemplateManager
              templates={templates.map((t) => ({
                id: t.id,
                name: t.name,
                subject: t.subject,
                body: t.body,
              }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'email' ? (
        <Group title="Email automation">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Automatic candidate emails on pipeline events.
            </p>
            <AutomationSettings
              templates={templates.map((t) => ({ id: t.id, name: t.name }))}
              settings={{
                autoConfirmTemplateId: org?.autoConfirmTemplateId ?? null,
                autoRejectTemplateId: org?.autoRejectTemplateId ?? null,
                autoInterviewTemplateId: org?.autoInterviewTemplateId ?? null,
                autoRejectDelayHours: org?.autoRejectDelayHours ?? 48,
              }}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Custom fields">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Extra fields shown on every candidate profile — notice period, visa status, current
              compensation, whatever your process tracks.
            </p>
            <CustomFieldsManager
              defs={fieldDefs.map((d) => ({ id: d.id, label: d.label, type: d.type, options: d.options }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="EEO self-identification">
          <ControlRow
            description="Adds the standard voluntary EEO/OFCCP block to apply forms. Responses are stored with no link to any candidate — structurally impossible to view individually, reported only in aggregate on Reports."
          >
            <EeoToggle enabled={org?.collectEeo ?? false} />
          </ControlRow>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Independent scorecards">
          <ControlRow
            description={
              <>
                Bias control: hide teammates&apos; interview feedback on a candidate until the
                viewer has submitted their own scorecard.
              </>
            }
          >
            <FeedbackVisibilityToggle enabled={org?.hideFeedbackUntilSubmitted ?? false} />
          </ControlRow>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Talent network">
          <ControlRow
            description={
              <>
                Adds an optional, unchecked opt-in to your apply forms: candidates can choose to be
                discoverable by other employers on the Source network. Consent is recorded per
                candidate and withdrawable from their status portal. (Network search &amp;
                distribution are Source ATS features.)
              </>
            }
          >
            <TalentNetworkToggle enabled={org?.talentNetworkEnabled ?? false} />
          </ControlRow>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Approvals">
          <Row>
            <p className="text-sm text-ink-2">
              When on, team members request approval instead of publishing a role or sending an
              offer — an admin reviews from the dashboard before anything goes live.
            </p>
          </Row>
          <Row className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">Job postings</p>
            <PostingApprovalToggle enabled={org?.requirePostingApproval ?? false} />
          </Row>
          <Row className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">Offers</p>
            <SettingsSwitch
              enabled={org?.requireOfferApproval ?? false}
              label="Require offer approval"
              onCaption="Approval required"
              offCaption="Anyone can send"
              onToggle={setRequireOfferApprovalAction}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Self-scheduling">
          <ControlRow
            description={
              <>
                When a candidate enters a Screen or On-site stage, email them a booking link against
                the opportunity owner&apos;s hours. Unused links are reused instead of minting
                duplicates.
              </>
            }
          >
            <SettingsSwitch
              enabled={org?.autoScheduleOnInterviewStages ?? false}
              label="Auto-send booking links"
              onCaption="Links send on stage entry"
              offCaption="Manual booking links only"
              onToggle={setAutoScheduleOnInterviewStagesAction}
            />
          </ControlRow>
        </Group>
        ) : null}

        {section === 'hiring' ? (
        <Group title="Scorecard questions">
          <Row>
            <p className="text-sm text-ink-2">
              Custom questions every interviewer answers alongside the overall rating and summary.
              Past feedback keeps its answers even if you change the questions later.
            </p>
          </Row>
          {scorecardQuestions.length ? (
            scorecardQuestions.map((q) => (
              <Row key={q.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="min-w-0 truncate">
                  {q.label}{' '}
                  <span className="text-xs text-ink-2">
                    · {q.kind === 'RATING' ? '1–4 rating' : 'free text'}
                  </span>
                </span>
                <form action={archiveScorecardQuestionAction.bind(null, q.id)}>
                  <button
                    type="submit"
                    className={buttonClass({ variant: 'ghost', size: 'xs', className: 'hover:text-critical' })}
                  >
                    Remove
                  </button>
                </form>
              </Row>
            ))
          ) : (
            <Row>
              <p className="text-sm text-ink-2">
                No custom questions yet — scorecards are the fixed overall rating + summary.
              </p>
            </Row>
          )}
          <Row>
            <form action={addScorecardQuestionAction} className="flex flex-wrap items-center gap-2">
              <input {...noAutofill}
                name="label"
                required
                placeholder="e.g. Technical depth, Communication…"
                className={cn(inputClass, 'min-w-64 flex-1')}
              />
              <select name="kind" defaultValue="RATING" className={cn(selectClass, 'w-auto')}>
                <option value="RATING">1–4 rating</option>
                <option value="TEXT">Free text</option>
              </select>
              <button type="submit" className={btnPrimary}>
                Add question
              </button>
            </form>
          </Row>
        </Group>
        ) : null}

        {section === 'integrations' && notetakers ? (
        <Group id="notetakers" title="Meeting notetakers · Beta">
          <NotetakerConnections
            connections={notetakers[0]}
            overview={notetakers[1]}
            demo={notetakers[2]}
            suggestedCount={notetakers[3]}
            notice={notetaker ? { result: notetaker, provider: notetakerProviderId ?? null } : null}
          />
        </Group>
        ) : null}

        {section === 'integrations' ? (
        <Group id="developers" title="API keys">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Bearer keys for the REST API (<code className="font-mono text-xs">/api/v1</code>):
              postings, opportunities, contacts, stages, and the event stream. Keys are shown once
              and stored hashed.
            </p>
            <ApiKeysManager
              keys={apiKeys.map((k) => ({
                id: k.id,
                name: k.name,
                prefix: k.prefix,
                createdAt: k.createdAt.toISOString(),
                lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
                revoked: !!k.revokedAt,
              }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'integrations' ? (
        <Group title="Webhooks">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              POST signed events (X-Source-Signature, HMAC-SHA256) to your endpoints as they
              happen — applications, stage moves, hires, and everything else in the event stream.
              Delivery is at-least-once with per-endpoint ordering.
            </p>
            <WebhooksManager
              endpoints={webhooks.map((w) => ({
                id: w.id,
                url: w.url,
                eventTypes: w.eventTypes,
                active: w.active,
                delivered: w.deliveries.filter((d) => d.success).length,
                failed: w.deliveries.filter((d) => !d.success).length,
              }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'integrations' && isAdmin(ctx) ? (
        <Group id="resume-parsing" title="Resume parsing">
          <Row>
            <ResumeParsingStatus orgId={ctx.orgId} />
          </Row>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group id="data" title="Contact import">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              Bulk-import contacts from a CSV with a header row:{' '}
              <code className="font-mono text-xs">name,email,phone,headline,location,tags</code>{' '}
              (only name is required; tags are ;-separated). Rows matching an existing email are
              skipped. Moving from another ATS? Use the full import below.
            </p>
            <CsvImport />
          </Row>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group title="Import from another ATS">
          <ControlRow description="Bring candidates, applications, postings, and their history over from the ATS you use today. Running it again only adds what's new.">
            <Link href="/settings/import" className={buttonClass({ variant: 'tonal', size: 'sm' })}>
              Start an import
            </Link>
          </ControlRow>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group title="Data export">
          <ControlRow
            description="Download everything your organization owns as JSON — candidates, postings, pipeline history, feedback, emails, and the full activity stream. Use it for backups or to move between self-hosted and managed Source."
          >
            <a href="/api/export" className={buttonClass({ variant: 'tonal', size: 'sm' })}>
              Export organization data
            </a>
          </ControlRow>
        </Group>
        ) : null}

        {section === 'team' ? (
        <Group id="team" title="Team">
          <Row>
            <TeamManager
              isAdmin={ctx.accessRole === 'SUPER_ADMIN' || ctx.accessRole === 'ADMIN'}
              googleSignIn={googleAuthEnabled()}
              members={members.map((m) => ({
                id: m.id,
                name: m.name,
                email: m.email,
                accessRole: m.accessRole,
                deactivated: !!m.deactivatedAt,
                isSelf: m.id === ctx.userId,
              }))}
            />
          </Row>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group title="Data retention">
          <Row>
            <p className="mb-4 text-sm text-ink-2">
              GDPR housekeeping: automatically anonymize candidates whose every process has been
              archived for longer than this many months (hired candidates are exempt). Leave blank
              to keep everything forever.
            </p>
            <form action={saveRetentionAction} className="flex items-center gap-2">
              <input {...noAutofill}
                type="number"
                name="retentionMonths"
                min="1"
                defaultValue={org?.retentionMonths ?? ''}
                placeholder="e.g. 24"
                className={cn(inputClass, 'w-28 tabular-nums')}
              />
              <span className="text-sm text-ink-2">months</span>
              <button type="submit" className={btnTonal}>
                Save
              </button>
            </form>
          </Row>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group title="Audit log">
          <ControlRow description="Every action by every user, API key, and automation — searchable and exportable.">
            <a href="/settings/audit" className={buttonClass({ variant: 'tonal', size: 'sm' })}>
              Open audit log
            </a>
          </ControlRow>
        </Group>
        ) : null}

        {section === 'data' ? (
        <Group title="Archive reasons">
          <Row className="flex flex-wrap gap-2">
            {archiveReasons.map((r) => (
              <span key={r.id} className={badge}>
                {r.name}
              </span>
            ))}
          </Row>
        </Group>
        ) : null}

      </div>
      </div>
    </div>
  );
}
