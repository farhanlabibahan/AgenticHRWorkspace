/**
 * Shared machinery for the external-ATS importers (Lever, Greenhouse).
 * Everything here targets an EXISTING org — importers merge into the org's
 * pipeline config (find-or-create by name) instead of replacing it, so you
 * can onboard first, adjust stages, then pull your history in.
 */
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'imported'
  );
}

/** Infer our StageType from a stage's display name. */
export function inferStageType(name) {
  const n = name.toLowerCase();
  if (/\bhired\b/.test(n)) return 'HIRED';
  if (/\boffer\b/.test(n)) return 'OFFER';
  if (/on-?site|face to face|final|panel|loop/.test(n)) return 'ONSITE';
  if (/lead|prospect|sourced|reached out|contacted|responded/.test(n)) return 'LEAD';
  if (/applicant|application|new candidate|review/.test(n)) return 'APPLICANT';
  return 'SCREEN';
}

/** Case-insensitive find-or-create registry for org stages. */
export async function stageRegistry(db, orgId) {
  const existing = await db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
  const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
  let nextOrder = existing.reduce((m, s) => Math.max(m, s.order), -1) + 1;
  return {
    async resolve(name) {
      const key = name.toLowerCase();
      if (byName.has(key)) return byName.get(key);
      const stage = await db.stage.create({
        data: { orgId, name, type: inferStageType(name), order: nextOrder++ },
      });
      byName.set(key, stage);
      return stage;
    },
  };
}

export async function reasonRegistry(db, orgId) {
  const existing = await db.archiveReason.findMany({ where: { orgId } });
  const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r]));
  return {
    async resolve(name) {
      const key = name.toLowerCase();
      if (byName.has(key)) return byName.get(key);
      const reason = await db.archiveReason.create({
        // "Hired" is an archive state in Lever, not a rejection
        data: { orgId, name, countsAsRejection: !/hired/i.test(name) },
      });
      byName.set(key, reason);
      return reason;
    },
  };
}

/** Contact dedup: by external id first, then by any matching email. */
export function contactRegistry(db, orgId) {
  const byExternalId = new Map();
  return {
    /** @returns {{ contact: object, created: boolean }} */
    async resolve(externalId, data) {
      if (externalId && byExternalId.has(externalId))
        return { contact: byExternalId.get(externalId), created: false };
      let contact = null;
      if (data.emails.length) {
        contact = await db.contact.findFirst({
          where: { orgId, emails: { hasSome: data.emails } },
        });
      }
      const created = !contact;
      if (!contact) {
        contact = await db.contact.create({
          data: {
            orgId,
            // Same cap as the app's write paths: names are btree-indexed.
            name: Array.from(data.name).slice(0, 500).join(''),
            headline: data.headline ?? null,
            location: data.location ?? null,
            emails: data.emails,
            phones: data.phones,
            links: data.links,
            tags: data.tags,
            createdAt: data.createdAt ?? new Date(),
          },
        });
      }
      if (externalId) byExternalId.set(externalId, contact);
      return { contact, created };
    },
  };
}

/**
 * Store a resume binary in local storage (.data/uploads) + StoredFile row.
 * The app's resume-text cron reads its text afterwards (every format it
 * supports, in an isolated worker), so the script doesn't parse documents.
 * Importers are a self-host/dev tool: on Blob-backed deployments re-upload
 * via the app or run the importer against the same volume the app mounts.
 */
export async function storeResume(db, orgId, contactId, filename, data) {
  const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const key = `${orgId}/${randomUUID()}-${safeName}`;
  const filePath = path.join(process.cwd(), '.data', 'uploads', key);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, data);

  const ext = path.extname(filename).toLowerCase();
  const mime =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/octet-stream';

  // Owned by the contact, so anonymizing them deletes it.
  const file = await db.storedFile.create({
    data: { orgId, key, filename, mime, size: data.byteLength, contactId },
  });
  await db.contact.update({ where: { id: contactId }, data: { resumeFileId: file.id } });
  return file;
}

export async function emitImportedEvent(db, orgId, opportunityId, source, externalId) {
  await db.event.create({
    data: {
      orgId,
      actorType: 'system',
      verb: 'opportunity.imported',
      subjectType: 'opportunity',
      subjectId: opportunityId,
      payload: { source, externalId },
    },
  });
}

/** Deterministic slug per external posting so re-runs reuse the same slug. */
export function externalSlug(title, externalId) {
  const hash = createHash('sha1').update(String(externalId)).digest('hex').slice(0, 6);
  return `${slugify(title)}-${hash}`;
}

/** First org admin — imported notes/feedback need an author to attribute to. */
export async function importUser(db, orgId) {
  const admin = await db.user.findFirst({
    where: { orgId, accessRole: { in: ['SUPER_ADMIN', 'ADMIN'] }, deactivatedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return admin ?? db.user.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
}

export function toDate(value) {
  if (value == null) return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}
