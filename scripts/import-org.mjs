#!/usr/bin/env node
/**
 * Source organization import — the second half of the self-hosted ↔ managed
 * migration path (docs/07-migration.md).
 *
 *   node scripts/import-org.mjs export.json --slug new-org-slug [--name "New Name"]
 *
 * Reads a Settings → Data export file and recreates the organization in the
 * target database (DATABASE_URL) with fresh IDs. Notes:
 *   - Users are imported WITHOUT passwords (credentials never leave a
 *     deployment) — teammates sign in after a password reset / re-invite.
 *   - Resume/file binaries are not part of the JSON export; file references
 *     are cleared. Parsed resume text is preserved.
 *   - API keys and webhook secrets are intentionally not migrated.
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const slug = args[args.indexOf('--slug') + 1];
const nameOverride = args.includes('--name') ? args[args.indexOf('--name') + 1] : null;

if (!file || !slug || slug.startsWith('--')) {
  console.error('Usage: node scripts/import-org.mjs <export.json> --slug <new-slug> [--name <name>]');
  process.exit(1);
}

const dump = JSON.parse(readFileSync(file, 'utf8'));
if (dump.exportVersion !== 1 && dump.exportVersion !== 2) {
  console.error(`Unsupported exportVersion: ${dump.exportVersion}`);
  process.exit(1);
}

const db = new PrismaClient();
const idMap = new Map(); // old id -> new id
const remap = (oldId) => {
  if (!oldId) return null;
  if (!idMap.has(oldId)) idMap.set(oldId, randomUUID());
  return idMap.get(oldId);
};
const mapped = (oldId) => (oldId && idMap.has(oldId) ? idMap.get(oldId) : null);

// Bulk inserts: a fixed number of round trips per 1,000 rows instead of one
// per row — the difference between minutes and hours against a remote DB.
const CHUNK = 1_000;
async function insertAll(tx, model, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx[model].createMany({ data: rows.slice(i, i + CHUNK) });
  }
}

async function main() {
  const existing = await db.organization.findUnique({ where: { slug } });
  if (existing) throw new Error(`Slug "${slug}" is already taken in the target database`);

  const src = dump.organization;
  const orgId = remap(src.id);

  await db.$transaction(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug,
        name: nameOverride ?? src.name,
        kind: src.kind,
        onboardedAt: src.onboardedAt ? new Date(src.onboardedAt) : new Date(),
        autoRejectDelayHours: src.autoRejectDelayHours ?? 48,
        talentNetworkEnabled: src.talentNetworkEnabled ?? false,
        hideFeedbackUntilSubmitted: src.hideFeedbackUntilSubmitted ?? false,
        retentionMonths: src.retentionMonths ?? null,
        collectEeo: src.collectEeo ?? false,
        createdAt: new Date(src.createdAt),
      },
    });

    await insertAll(tx, 'user', dump.users.map((u) => ({
          id: remap(u.id),
          orgId,
          email: u.email,
          name: u.name,
          passwordHash: null, // credentials never migrate
          accessRole: u.accessRole,
          deactivatedAt: u.deactivatedAt ? new Date(u.deactivatedAt) : null,
          createdAt: new Date(u.createdAt),
        })));

    await insertAll(tx, 'department', (dump.departments ?? []).map((d) => ({ id: remap(d.id), orgId, name: d.name })));
    await insertAll(tx, 'clientCompany', (dump.clientCompanies ?? []).map((c) => ({ id: remap(c.id), orgId, name: c.name })));

    await insertAll(tx, 'stage', dump.stages.map((s) => ({ id: remap(s.id), orgId, name: s.name, type: s.type, order: s.order })));
    await insertAll(tx, 'archiveReason', dump.archiveReasons.map((r) => ({ id: remap(r.id), orgId, name: r.name, countsAsRejection: r.countsAsRejection })));
    await insertAll(tx, 'emailTemplate', (dump.emailTemplates ?? []).map((t) => ({ id: remap(t.id), orgId, name: t.name, subject: t.subject, body: t.body })));

    // Automation pointers now that templates exist
    await tx.organization.update({
      where: { id: orgId },
      data: {
        autoConfirmTemplateId: mapped(src.autoConfirmTemplateId),
        autoRejectTemplateId: mapped(src.autoRejectTemplateId),
        autoInterviewTemplateId: mapped(src.autoInterviewTemplateId),
      },
    });

    await insertAll(tx, 'contact', dump.contacts.map((c) => ({
          id: remap(c.id),
          orgId,
          name: c.name,
          headline: c.headline,
          location: c.location,
          emails: c.emails ?? [],
          phones: c.phones ?? [],
          links: c.links ?? [],
          tags: c.tags ?? [],
          resumeFileId: null, // binaries not in the JSON export
          resumeText: c.resumeText ?? null,
          isAnonymized: c.isAnonymized ?? false,
          createdAt: new Date(c.createdAt),
        })));

    await insertAll(tx, 'requisition', (dump.requisitions ?? []).map((r) => ({
          id: remap(r.id),
          orgId,
          code: r.code,
          title: r.title,
          state: r.state,
          openings: r.openings,
          filled: r.filled ?? 0,
          backfill: r.backfill ?? false,
          salaryMin: r.salaryMin,
          salaryMax: r.salaryMax,
          salaryCurrency: r.salaryCurrency ?? 'USD',
          createdAt: new Date(r.createdAt),
        })));

    await insertAll(tx, 'customFieldDef', (dump.customFieldDefs ?? []).map((d) => ({ id: remap(d.id), orgId, key: d.key, label: d.label, type: d.type, options: d.options ?? [] })));

    await insertAll(tx, 'posting', dump.postings.map((p) => ({
          id: remap(p.id),
          orgId,
          requisitionId: mapped(p.requisitionId),
          slug: p.slug,
          title: p.title,
          state: p.state,
          departmentId: mapped(p.departmentId),
          clientCompanyId: mapped(p.clientCompanyId),
          location: p.location,
          workplaceType: p.workplaceType,
          commitment: p.commitment,
          salaryMin: p.salaryMin,
          salaryMax: p.salaryMax,
          salaryCurrency: p.salaryCurrency,
          content: p.content ?? undefined,
          tags: p.tags ?? [],
          createdAt: new Date(p.createdAt),
        })));

    await insertAll(tx, 'interviewPlanStep', (dump.planSteps ?? []).map((ps) => ({
          id: remap(ps.id),
          orgId,
          postingId: mapped(ps.postingId),
          title: ps.title,
          durationMins: ps.durationMins ?? 60,
          focusAreas: ps.focusAreas ?? [],
          order: ps.order ?? 0,
        })));

    await insertAll(tx, 'opportunity', dump.opportunities.map((o) => ({
          id: remap(o.id),
          orgId,
          contactId: mapped(o.contactId),
          postingId: mapped(o.postingId),
          stageId: mapped(o.stageId),
          status: o.status,
          origin: o.origin,
          source: o.source,
          archiveReasonId: mapped(o.archiveReasonId),
          archivedAt: o.archivedAt ? new Date(o.archivedAt) : null,
          ownerId: mapped(o.ownerId),
          confidential: o.confidential ?? false,
          customFields: o.customFields ?? undefined,
          snoozedUntil: o.snoozedUntil ? new Date(o.snoozedUntil) : null,
          stageChangedAt: new Date(o.stageChangedAt),
          createdAt: new Date(o.createdAt),
        })));

    await insertAll(tx, 'stageTransition', dump.stageTransitions.map((t) => ({
          id: remap(t.id),
          opportunityId: mapped(t.opportunityId),
          fromStageId: mapped(t.fromStageId),
          toStageId: mapped(t.toStageId),
          actorId: mapped(t.actorId),
          occurredAt: new Date(t.occurredAt),
        })));

    await insertAll(tx, 'interview', (dump.interviews ?? []).map((iv) => ({
          id: remap(iv.id),
          orgId,
          opportunityId: mapped(iv.opportunityId),
          title: iv.title,
          startAt: new Date(iv.startAt),
          durationMins: iv.durationMins,
          location: iv.location,
          focusAreas: iv.focusAreas ?? [],
          state: iv.state,
        })));
    // Panels live in Prisma's implicit join table, which createMany can't reach.
    const panels = (dump.interviews ?? []).flatMap((iv) =>
      (iv.panelists ?? [])
        .map((p) => mapped(p.id))
        .filter(Boolean)
        .map((userId) => [mapped(iv.id), userId]),
    );
    for (let i = 0; i < panels.length; i += CHUNK) {
      const chunk = panels.slice(i, i + CHUNK);
      await tx.$executeRaw`INSERT INTO "_InterviewPanelists" ("A", "B")
        SELECT * FROM unnest(${chunk.map((p) => p[0])}::text[], ${chunk.map((p) => p[1])}::text[])`;
    }

    await insertAll(tx, 'feedbackSubmission', (dump.feedback ?? []).map((f) => ({
          id: remap(f.id),
          orgId,
          opportunityId: mapped(f.opportunityId),
          interviewId: mapped(f.interviewId),
          authorId: mapped(f.authorId),
          overallRating: f.overallRating,
          summary: f.summary,
          answers: f.answers ?? undefined,
          createdAt: new Date(f.createdAt),
        })));

    await insertAll(tx, 'note', (dump.notes ?? []).map((n) => ({
          id: remap(n.id),
          orgId,
          opportunityId: mapped(n.opportunityId),
          authorId: mapped(n.authorId),
          body: n.body,
          mentions: n.mentions ?? [],
          createdAt: new Date(n.createdAt),
        })));

    await insertAll(tx, 'emailMessage', (dump.emailMessages ?? []).map((m) => ({
          id: remap(m.id),
          orgId,
          contactId: mapped(m.contactId),
          opportunityId: mapped(m.opportunityId),
          templateId: mapped(m.templateId),
          senderId: mapped(m.senderId),
          toEmail: m.toEmail,
          subject: m.subject,
          body: m.body,
          status: m.status,
          scheduledAt: m.scheduledAt ? new Date(m.scheduledAt) : null,
          sentAt: m.sentAt ? new Date(m.sentAt) : null,
          error: m.error,
          createdAt: new Date(m.createdAt),
        })));

    await insertAll(tx, 'consentRecord', (dump.consents ?? []).map((c) => ({
          id: remap(c.id),
          orgId,
          contactId: mapped(c.contactId),
          purpose: c.purpose,
          policyVersion: c.policyVersion,
          grantedAt: new Date(c.grantedAt),
          withdrawnAt: c.withdrawnAt ? new Date(c.withdrawnAt) : null,
        })));

    await insertAll(tx, 'task', (dump.tasks ?? []).map((t) => ({
          id: remap(t.id),
          orgId,
          opportunityId: mapped(t.opportunityId),
          assigneeId: mapped(t.assigneeId),
          creatorId: mapped(t.creatorId),
          title: t.title,
          dueAt: t.dueAt ? new Date(t.dueAt) : null,
          completedAt: t.completedAt ? new Date(t.completedAt) : null,
          createdAt: new Date(t.createdAt),
        })));

    await insertAll(tx, 'offer', (dump.offers ?? []).map((o) => ({
          id: remap(o.id),
          orgId,
          opportunityId: mapped(o.opportunityId),
          status: o.status,
          jobTitle: o.jobTitle,
          salaryAmount: o.salaryAmount,
          salaryCurrency: o.salaryCurrency ?? 'USD',
          equity: o.equity,
          startDate: o.startDate ? new Date(o.startDate) : null,
          expiresAt: o.expiresAt ? new Date(o.expiresAt) : null,
          notes: o.notes,
          createdById: mapped(o.createdById),
          sentAt: o.sentAt ? new Date(o.sentAt) : null,
          respondedAt: o.respondedAt ? new Date(o.respondedAt) : null,
          createdAt: new Date(o.createdAt),
        })));

    await insertAll(tx, 'transcript', (dump.transcripts ?? []).map((t) => ({
          id: remap(t.id),
          orgId,
          opportunityId: mapped(t.opportunityId),
          interviewId: mapped(t.interviewId),
          title: t.title,
          content: t.content,
          source: t.source ?? 'manual',
          createdAt: new Date(t.createdAt),
        })));

    // Nurture campaigns aren't part of the open-source core; an older
    // export's campaigns and enrollments are skipped.

    await insertAll(tx, 'savedReport', (dump.savedReports ?? []).map((r) => ({ id: remap(r.id), orgId, name: r.name, config: r.config ?? {}, createdAt: new Date(r.createdAt) })));

    // EEO rows carry no candidate linkage by design; postingId is remapped
    await insertAll(tx, 'eeoResponse', (dump.eeoResponses ?? []).map((r) => ({
          id: remap(r.id),
          orgId,
          postingId: mapped(r.postingId),
          gender: r.gender,
          race: r.race,
          veteran: r.veteran,
          disability: r.disability,
          createdAt: new Date(r.createdAt),
        })));

    await insertAll(tx, 'event', (dump.events ?? []).map((e) => ({
          id: remap(e.id),
          orgId,
          actorType: e.actorType,
          actorId: mapped(e.actorId) ?? e.actorId, // keep old id if unmapped (audit fidelity)
          verb: e.verb,
          subjectType: e.subjectType,
          subjectId: mapped(e.subjectId) ?? e.subjectId,
          payload: e.payload ?? undefined,
          occurredAt: new Date(e.occurredAt),
        })));

    // ATS-import ledger. A ref whose record wasn't exported (deleted or
    // erased since) gets an id that points nowhere — still a tombstone, so
    // re-importing never brings that candidate back.
    await insertAll(tx, 'importRef', (dump.importRefs ?? []).filter((r) => r.kind !== 'file').map((r) => ({
          id: remap(r.id),
          orgId,
          provider: r.provider,
          kind: r.kind,
          externalId: r.externalId,
          internalId: mapped(r.internalId) ?? randomUUID(),
          created: r.created,
          createdAt: new Date(r.createdAt),
        })));
  }, { timeout: 30 * 60_000, maxWait: 60_000 }); // one atomic import, however large

  const counts = {
    users: dump.users.length,
    contacts: dump.contacts.length,
    postings: dump.postings.length,
    opportunities: dump.opportunities.length,
    events: (dump.events ?? []).length,
  };
  console.log(`Imported "${nameOverride ?? src.name}" as ${slug}:`, JSON.stringify(counts));
  console.log('Teammates must reset passwords (credentials are never migrated).');
}

main()
  .catch((e) => {
    console.error('Import failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
