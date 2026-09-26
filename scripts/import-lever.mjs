#!/usr/bin/env node
/**
 * Import a Lever export into an existing Source organization.
 *
 * Most teams should use Settings → Import from another ATS, which pulls
 * everything (offers included) straight from Lever's API, resumably and
 * re-run-safe. This script is for offline lever-export dumps.
 *
 *   node scripts/import-lever.mjs <export-dir> --slug <org-slug>
 *
 * <export-dir> is the output of github.com/theck01/lever-export:
 *   data/lever-export.json                       — array of expanded Opportunity objects
 *   data/assetsByOpportunityId/:id/resumes/:file — resume binaries
 * A direct path to the JSON file also works (assets are then skipped).
 *
 * What lands where:
 *   stages/archive reasons — matched to your pipeline by name (case-insensitive),
 *     created with an inferred type when missing
 *   applications[].posting — Postings (+ Departments for company orgs)
 *   opportunities          — Contacts (deduped by Lever contact id, then email)
 *     + Opportunities with full stageChanges history as StageTransitions
 *   notes / feedback       — Notes and FeedbackSubmissions attributed to your
 *     first admin, original author kept in the text. Feedback without a
 *     parseable 1-4 score is imported as a note instead of inventing a rating.
 *   panels[].interviews    — Interviews (panelist accounts don't migrate)
 *   resumes                — stored locally (.data/uploads) + text extraction
 * Offers and custom forms are not imported; the Lever opportunity id is kept
 * in customFields.leverId for spot-checking against the source.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  contactRegistry,
  emitImportedEvent,
  externalSlug,
  importUser,
  reasonRegistry,
  stageRegistry,
  storeResume,
  toDate,
} from './lib/ats-import.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const slug = args[args.indexOf('--slug') + 1];
if (!target || !slug || slug.startsWith('--')) {
  console.error('Usage: node scripts/import-lever.mjs <export-dir | lever-export.json> --slug <org-slug>');
  process.exit(1);
}

// Accept the export dir, its data/ subdir, or the JSON file itself
let jsonPath = target;
let assetsDir = null;
if (statSync(target).isDirectory()) {
  jsonPath = ['data/lever-export.json', 'lever-export.json']
    .map((p) => path.join(target, p))
    .find(existsSync);
  if (!jsonPath) {
    console.error(`No lever-export.json found under ${target}`);
    process.exit(1);
  }
  assetsDir = path.join(path.dirname(jsonPath), 'assetsByOpportunityId');
  if (!existsSync(assetsDir)) assetsDir = null;
}

const opportunities = JSON.parse(readFileSync(jsonPath, 'utf8'));
if (!Array.isArray(opportunities)) {
  console.error('Expected lever-export.json to be an array of Opportunity objects');
  process.exit(1);
}

// Lever expands references into objects; unexpanded exports keep bare ids.
const refId = (v) => (v && typeof v === 'object' ? v.id : (v ?? null));
const refText = (v, fallback) =>
  v && typeof v === 'object' ? (v.text ?? v.name ?? fallback) : (typeof v === 'string' ? prettify(v) : fallback);
const prettify = (id) =>
  id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const ORIGINS = new Set(['APPLIED', 'SOURCED', 'REFERRED', 'AGENCY', 'INTERNAL', 'UNIVERSITY']);
const COMMITMENTS = [
  [/full.?time/i, 'FULL_TIME'],
  [/part.?time/i, 'PART_TIME'],
  [/contract|temp/i, 'CONTRACT'],
  [/intern/i, 'INTERNSHIP'],
];

const db = new PrismaClient();

async function main() {
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) throw new Error(`No organization with slug "${slug}" — create and onboard it first`);
  const author = await importUser(db, org.id);

  const stages = await stageRegistry(db, org.id);
  const reasons = await reasonRegistry(db, org.id);
  const contacts = contactRegistry(db, org.id);
  const departments = new Map(
    (await db.department.findMany({ where: { orgId: org.id } })).map((d) => [d.name.toLowerCase(), d]),
  );
  const postingsByLeverId = new Map();

  // stageChanges carry bare Lever stage ids while the current stage is
  // expanded — harvest every expanded {id, text} so history resolves to real
  // names instead of prettified ids.
  const leverStageNames = new Map();
  for (const opp of opportunities) {
    const s = opp?.stage;
    if (s && typeof s === 'object' && s.id && s.text) leverStageNames.set(s.id, s.text);
  }
  const stageName = (ref) => {
    const id = refId(ref);
    if (id && leverStageNames.has(id)) return leverStageNames.get(id);
    return refText(ref, 'Imported');
  };

  const counts = { contacts: 0, postings: 0, opportunities: 0, transitions: 0, notes: 0, feedback: 0, interviews: 0, resumes: 0, skipped: 0 };

  for (const opp of opportunities) {
    if (!opp || !opp.id || !opp.name) {
      counts.skipped++;
      continue;
    }

    // ----- contact -----
    const location = typeof opp.location === 'object' ? (opp.location?.name ?? null) : (opp.location ?? null);
    const emails = [...new Set((opp.emails ?? []).map((e) => String(e).toLowerCase()))];
    const contactData = {
      name: opp.name,
      headline: opp.headline || null,
      location,
      emails,
      phones: (opp.phones ?? []).map((p) => (typeof p === 'object' ? p.value : String(p))).filter(Boolean),
      links: (opp.links ?? []).filter(Boolean),
      tags: opp.tags ?? [],
      createdAt: toDate(opp.createdAt) ?? new Date(),
    };
    const { contact, created } = await contacts.resolve(refId(opp.contact) ?? opp.id, contactData);
    if (created) counts.contacts++;

    // ----- posting (first application wins) -----
    let postingId = null;
    const application = (opp.applications ?? [])[0];
    const leverPosting = application?.posting ?? null;
    if (leverPosting) {
      const leverPostingId = refId(leverPosting) ?? refText(leverPosting, 'unknown');
      if (postingsByLeverId.has(leverPostingId)) {
        postingId = postingsByLeverId.get(leverPostingId);
      } else {
        const title = refText(leverPosting, application?.postingTitle ?? 'Imported posting');
        const categories = typeof leverPosting === 'object' ? (leverPosting.categories ?? {}) : {};
        let departmentId = null;
        if (org.kind === 'COMPANY' && categories.department) {
          const key = categories.department.toLowerCase();
          if (!departments.has(key)) {
            departments.set(key, await db.department.create({ data: { orgId: org.id, name: categories.department } }));
          }
          departmentId = departments.get(key).id;
        }
        const commitment = COMMITMENTS.find(([re]) => re.test(categories.commitment ?? ''))?.[1] ?? 'FULL_TIME';
        const postingSlug = externalSlug(title, leverPostingId);
        let posting = await db.posting.findUnique({
          where: { orgId_slug: { orgId: org.id, slug: postingSlug } },
        });
        if (!posting) {
          posting = await db.posting.create({
            data: {
              orgId: org.id,
              slug: postingSlug,
              title,
              // Imported postings arrive closed — publish deliberately, not by accident
              state: 'CLOSED',
              departmentId,
              location: categories.location ?? null,
              commitment,
              tags: categories.team ? [categories.team] : [],
            },
          });
          counts.postings++;
        }
        postingsByLeverId.set(leverPostingId, posting.id);
        postingId = posting.id;
      }
    }

    // ----- stage + status -----
    const stage = await stages.resolve(stageName(opp.stage));
    const archived = opp.archived ?? null;
    const reason = archived?.reason != null ? await reasons.resolve(refText(archived.reason, 'Imported reason')) : null;
    const hired = (reason && !reason.countsAsRejection) || stage.type === 'HIRED';
    const status = archived ? (hired ? 'HIRED' : 'ARCHIVED') : stage.type === 'HIRED' ? 'HIRED' : 'ACTIVE';
    const origin = ORIGINS.has(String(opp.origin ?? '').toUpperCase()) ? String(opp.origin).toUpperCase() : 'APPLIED';

    const stageChanges = (opp.stageChanges ?? []).slice().sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    const lastChange = stageChanges[stageChanges.length - 1];

    const opportunity = await db.opportunity.create({
      data: {
        orgId: org.id,
        contactId: contact.id,
        postingId,
        stageId: stage.id,
        status,
        origin,
        source: (opp.sources ?? [])[0] ?? null,
        archiveReasonId: reason?.id ?? null,
        archivedAt: toDate(archived?.archivedAt),
        stageChangedAt: toDate(lastChange?.updatedAt) ?? toDate(opp.createdAt) ?? new Date(),
        createdAt: toDate(opp.createdAt) ?? new Date(),
        customFields: { leverId: opp.id },
      },
    });
    counts.opportunities++;

    // ----- stage history -----
    let fromStageId = null;
    for (const change of stageChanges) {
      const toStage = await stages.resolve(stageName(change.toStageId));
      await db.stageTransition.create({
        data: {
          opportunityId: opportunity.id,
          fromStageId,
          toStageId: toStage.id,
          occurredAt: toDate(change.updatedAt) ?? new Date(),
        },
      });
      fromStageId = toStage.id;
      counts.transitions++;
    }

    // ----- notes -----
    for (const note of opp.notes ?? []) {
      const text = (note.fields ?? [])
        .map((f) => f.value)
        .filter(Boolean)
        .join('\n\n');
      if (!text || !author) continue;
      const by = note.user && typeof note.user === 'object' ? note.user.name : null;
      await db.note.create({
        data: {
          orgId: org.id,
          opportunityId: opportunity.id,
          authorId: author.id,
          body: `${by ? `[Imported from Lever — ${by}] ` : '[Imported from Lever] '}${text}`,
          createdAt: toDate(note.createdAt) ?? new Date(),
        },
      });
      counts.notes++;
    }

    // ----- feedback (scorecard if a 1-4 score parses, note otherwise) -----
    for (const fb of opp.feedback ?? []) {
      if (!author) continue;
      const lines = (fb.fields ?? [])
        .filter((f) => f.value != null && f.value !== '')
        .map((f) => (f.text ? `${f.text}: ${f.value}` : String(f.value)));
      const scoreField = (fb.fields ?? []).find((f) => /score/i.test(f.type ?? '') && f.value != null);
      const score = scoreField ? Number.parseInt(String(scoreField.value), 10) : NaN;
      const by = fb.user && typeof fb.user === 'object' ? fb.user.name : null;
      const header = `[Imported from Lever${by ? ` — ${by}` : ''}] ${fb.text ?? 'Interview feedback'}`;
      if (Number.isInteger(score) && score >= 1 && score <= 4) {
        await db.feedbackSubmission.create({
          data: {
            orgId: org.id,
            opportunityId: opportunity.id,
            authorId: author.id,
            overallRating: score,
            summary: `${header}\n${lines.join('\n')}`.slice(0, 8000),
            createdAt: toDate(fb.completedAt ?? fb.createdAt) ?? new Date(),
          },
        });
        counts.feedback++;
      } else if (lines.length) {
        await db.note.create({
          data: {
            orgId: org.id,
            opportunityId: opportunity.id,
            authorId: author.id,
            body: `${header}\n${lines.join('\n')}`.slice(0, 8000),
            createdAt: toDate(fb.createdAt) ?? new Date(),
          },
        });
        counts.notes++;
      }
    }

    // ----- panels → interviews -----
    for (const panel of opp.panels ?? []) {
      for (const iv of panel.interviews ?? []) {
        const startAt = toDate(iv.date ?? iv.at ?? panel.start);
        if (!startAt) continue;
        await db.interview.create({
          data: {
            orgId: org.id,
            opportunityId: opportunity.id,
            title: iv.subject ?? iv.name ?? 'Imported interview',
            startAt,
            durationMins: Number.isFinite(iv.duration) ? iv.duration : 60,
            location: iv.location ?? null,
            state: startAt < new Date() ? 'COMPLETED' : 'SCHEDULED',
          },
        });
        counts.interviews++;
      }
    }

    // ----- resume binary + text -----
    if (assetsDir) {
      const resumeDir = path.join(assetsDir, opp.id, 'resumes');
      if (existsSync(resumeDir)) {
        const files = readdirSync(resumeDir).filter((f) => !f.startsWith('.'));
        if (files.length && !contact.resumeFileId) {
          await storeResume(db, org.id, contact.id, files[0], readFileSync(path.join(resumeDir, files[0])));
          counts.resumes++;
        }
      }
    }

    await emitImportedEvent(db, org.id, opportunity.id, 'lever', opp.id);
  }

  console.log(`Imported into "${org.name}" (${slug}):`, JSON.stringify(counts));
}

main()
  .catch((e) => {
    console.error('Import failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
