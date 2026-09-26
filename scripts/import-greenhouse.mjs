#!/usr/bin/env node
/**
 * Import a Greenhouse Harvest export into an existing Source organization.
 *
 * For live data use Settings → Import from another ATS instead: Harvest
 * v1/v2 were shut off on Aug 31, 2026, and the in-app importer uses Harvest
 * v3. This script remains for v1 JSON dumps taken before then.
 *
 *   node scripts/import-greenhouse.mjs <export-dir> --slug <org-slug> [--download-resumes]
 *
 * <export-dir> contains plain Harvest API dumps (all pages concatenated into
 * one JSON array per file):
 *   candidates.json — GET /v1/candidates  (applications come embedded)
 *   jobs.json       — GET /v1/jobs        (optional; enriches postings)
 * e.g.  curl -u "$HARVEST_KEY:" "https://harvest.greenhouse.io/v1/candidates?per_page=500&page=N"
 *
 * What lands where:
 *   applications[].current_stage — matched to your pipeline by name
 *     (case-insensitive), created with an inferred type when missing
 *   applications[].jobs          — Postings (+ Departments for company orgs,
 *     enriched from jobs.json when present)
 *   candidates                   — Contacts (deduped by Greenhouse id, then email)
 *   applications                 — Opportunities: hired/rejected/active status,
 *     rejection_reason as archive reason, prospect → SOURCED origin
 *   attachments (type resume)    — with --download-resumes, fetched and stored
 *     locally (.data/uploads) + text extraction. Harvest attachment URLs
 *     expire, so run the import promptly after the export.
 * Scorecards/activity feed are not part of the candidate dump and are not
 * imported; the Greenhouse ids are kept in customFields.greenhouseId.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  contactRegistry,
  emitImportedEvent,
  externalSlug,
  reasonRegistry,
  stageRegistry,
  storeResume,
  toDate,
} from './lib/ats-import.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const slug = args[args.indexOf('--slug') + 1];
const downloadResumes = args.includes('--download-resumes');
if (!target || !slug || slug.startsWith('--')) {
  console.error('Usage: node scripts/import-greenhouse.mjs <export-dir> --slug <org-slug> [--download-resumes]');
  process.exit(1);
}

const dir = statSync(target).isDirectory() ? target : path.dirname(target);
const candidatesPath = path.join(dir, 'candidates.json');
if (!existsSync(candidatesPath)) {
  console.error(`No candidates.json found under ${dir}`);
  process.exit(1);
}
const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8'));
const jobsPath = path.join(dir, 'jobs.json');
const jobs = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, 'utf8')) : [];
const jobsById = new Map(jobs.map((j) => [j.id, j]));

const db = new PrismaClient();

async function main() {
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) throw new Error(`No organization with slug "${slug}" — create and onboard it first`);

  const stages = await stageRegistry(db, org.id);
  const reasons = await reasonRegistry(db, org.id);
  const contacts = contactRegistry(db, org.id);
  const departments = new Map(
    (await db.department.findMany({ where: { orgId: org.id } })).map((d) => [d.name.toLowerCase(), d]),
  );
  const postingsByGhId = new Map();

  const counts = { contacts: 0, postings: 0, opportunities: 0, resumes: 0, resumeErrors: 0, skipped: 0 };

  for (const cand of candidates) {
    if (!cand || !cand.id) {
      counts.skipped++;
      continue;
    }

    const name = [cand.first_name, cand.last_name].filter(Boolean).join(' ').trim() || 'Unknown candidate';
    const emails = [...new Set((cand.email_addresses ?? []).map((e) => String(e.value).toLowerCase()))];
    const headline =
      [cand.title, cand.company].filter(Boolean).join(' at ') || null;
    const { contact, created } = await contacts.resolve(String(cand.id), {
      name,
      headline,
      location: cand.addresses?.[0]?.value ?? null,
      emails,
      phones: (cand.phone_numbers ?? []).map((p) => p.value).filter(Boolean),
      links: [...(cand.website_addresses ?? []), ...(cand.social_media_addresses ?? [])]
        .map((w) => w.value)
        .filter(Boolean),
      tags: cand.tags ?? [],
      createdAt: toDate(cand.created_at) ?? new Date(),
    });
    if (created) counts.contacts++;

    for (const app of cand.applications ?? []) {
      // ----- posting -----
      let postingId = null;
      const ghJob = (app.jobs ?? [])[0];
      if (ghJob) {
        if (postingsByGhId.has(ghJob.id)) {
          postingId = postingsByGhId.get(ghJob.id);
        } else {
          const full = jobsById.get(ghJob.id);
          const title = ghJob.name ?? full?.name ?? 'Imported posting';
          let departmentId = null;
          const deptName = full?.departments?.[0]?.name;
          if (org.kind === 'COMPANY' && deptName) {
            const key = deptName.toLowerCase();
            if (!departments.has(key)) {
              departments.set(key, await db.department.create({ data: { orgId: org.id, name: deptName } }));
            }
            departmentId = departments.get(key).id;
          }
          const postingSlug = externalSlug(title, ghJob.id);
          let posting = await db.posting.findUnique({
            where: { orgId_slug: { orgId: org.id, slug: postingSlug } },
          });
          if (!posting) {
            posting = await db.posting.create({
              data: {
                orgId: org.id,
                slug: postingSlug,
                title,
                // Imported postings arrive closed — publish deliberately
                state: 'CLOSED',
                departmentId,
                location: full?.offices?.[0]?.name ?? null,
              },
            });
            counts.postings++;
          }
          postingsByGhId.set(ghJob.id, posting.id);
          postingId = posting.id;
        }
      }

      // ----- stage + status -----
      const stage = await stages.resolve(app.current_stage?.name ?? 'Imported');
      const rejected = app.status === 'rejected';
      const hired = app.status === 'hired';
      const reason = rejected
        ? await reasons.resolve(app.rejection_reason?.name ?? 'Rejected (imported)')
        : hired
          ? await reasons.resolve('Hired')
          : null;

      const opportunity = await db.opportunity.create({
        data: {
          orgId: org.id,
          contactId: contact.id,
          postingId,
          stageId: stage.id,
          status: hired ? 'HIRED' : rejected ? 'ARCHIVED' : 'ACTIVE',
          origin: app.prospect ? 'SOURCED' : 'APPLIED',
          source: app.source?.public_name ?? null,
          archiveReasonId: reason?.id ?? null,
          archivedAt: toDate(app.rejected_at) ?? (hired ? toDate(app.last_activity_at) : null),
          stageChangedAt: toDate(app.last_activity_at) ?? toDate(app.applied_at) ?? new Date(),
          createdAt: toDate(app.applied_at) ?? new Date(),
          customFields: { greenhouseId: app.id, greenhouseCandidateId: cand.id },
        },
      });
      counts.opportunities++;

      // ----- resume attachment -----
      if (downloadResumes && !contact.resumeFileId) {
        const resume = (app.attachments ?? []).find((a) => a.type === 'resume' && a.url);
        if (resume) {
          try {
            const res = await fetch(resume.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = Buffer.from(await res.arrayBuffer());
            await storeResume(db, org.id, contact.id, resume.filename ?? 'resume.pdf', data);
            contact.resumeFileId = 'set'; // don't re-fetch for later applications
            counts.resumes++;
          } catch {
            counts.resumeErrors++; // expired URL etc. — never blocks the import
          }
        }
      }

      await emitImportedEvent(db, org.id, opportunity.id, 'greenhouse', app.id);
    }
  }

  console.log(`Imported into "${org.name}" (${slug}):`, JSON.stringify(counts));
  if (counts.resumeErrors)
    console.log(`${counts.resumeErrors} resume download(s) failed — Harvest URLs expire; re-export if needed.`);
}

main()
  .catch((e) => {
    console.error('Import failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
