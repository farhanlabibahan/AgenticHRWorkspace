import { createHmac, randomBytes } from 'crypto';
import path from 'path';
import { Prisma, type InterviewState, type OfferStatus, type OrgKind, type PostingState, type RequisitionState, type StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { ImportAuthError, ImportHttpError } from '@/server/imports/http';
import { externalSlug, inferStageType, looseKey, nameKey, type AppliedMapping } from '@/server/imports/mapping';
import { insertStages } from '@/server/imports/pipeline';
import { fingerprint, mergeRecord, snapshotOf, untouchedSince } from '@/server/imports/resync';
import { clip, scrub } from '@/server/imports/text';
import type {
  ImportedApplication,
  ImportedCandidate,
  ImportedFeedback,
  ImportedFile,
  ImportedInterview,
  ImportedNote,
  ImportedOffer,
  ImportedPosting,
  ImportedRequisition,
  ImportOptions,
  Loader,
  ReasonRef,
  RefKind,
  StageRef,
} from '@/server/imports/types';
import { fileStorageAvailable, putFileBytes } from '@/server/storage';
import { extractText, textFields } from '@/server/text';

/**
 * Writes normalized vendor records into an org, idempotently.
 *
 * Each record and its ImportRef are created in one transaction, so a step
 * that dies halfway and is replayed never duplicates anything. A ref whose
 * record was since deleted or anonymized is a tombstone: re-importing must
 * not resurrect a candidate someone erased.
 *
 * Re-imports: a record that already has a ref is updated from the vendor,
 * not skipped. Unchanged records (same fingerprint) cost no write; changed
 * ones get a three-way merge against what the last import wrote, so the
 * vendor's changes land and the team's edits in Orqestra stay (resync.ts).
 * Nothing is deleted when it disappears at the vendor.
 *
 * Writes go straight to Prisma rather than through the app's services on
 * purpose: importing history must not send confirmation emails, mint
 * scheduling links, fill requisitions, or fan events out to webhooks.
 */

export type LoaderStats = Record<string, number>;

export type LoaderDeps = {
  orgId: string;
  orgKind: OrgKind;
  provider: string;
  providerName: string;
  jobId: string;
  /** Imported notes/feedback whose author isn't a teammate are credited here. */
  fallbackAuthorId: string;
  mapping: AppliedMapping;
  options: ImportOptions;
  since: Date | null;
  /**
   * When this import job started. A record delivered twice in one run (Lever
   * sends the candidate with each of their applications) is taken the first
   * time, as before re-imports; merging is between runs.
   */
  startedAt?: Date;
  /** The provider's adapter sends complete records on re-imports (ProviderModule.updatesOnReimport). Otherwise records imported before are left as they are. */
  updates?: boolean;
  stats: LoaderStats;
  warn: (message: string, detail?: { entity?: string; externalId?: string }) => void;
};

/**
 * The only types an imported file is stored as. Vendor Content-Types can be
 * anything (text/html, SVG); a file recorded with one of those would be a
 * script waiting to run on our origin, so everything else becomes
 * application/octet-stream regardless of what the vendor or extension says.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const SAFE_MIMES = new Set(Object.values(MIME_BY_EXT));

export function safeMime(declared: string | null | undefined, filename: string): string {
  const type = declared?.split(';')[0].trim().toLowerCase();
  if (type && SAFE_MIMES.has(type)) return type;
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Orqestra's numeric columns are 32-bit ints. */
function int32(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(n)));
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createLoader(deps: LoaderDeps): Loader {
  const { orgId, provider, jobId, options } = deps;
  const refCache = new Map<string, string | null>();
  const bump = (stat: string, by = 1) => {
    deps.stats[stat] = (deps.stats[stat] ?? 0) + by;
  };

  // ---------- refs ----------

  async function ref(kind: RefKind, externalId: string | null | undefined): Promise<string | null> {
    if (!externalId) return null;
    const key = `${kind}:${externalId}`;
    if (refCache.has(key)) return refCache.get(key)!;
    const row = await db.importRef.findUnique({
      where: { orgId_provider_kind_externalId: { orgId, provider, kind, externalId: String(externalId) } },
      select: { internalId: true },
    });
    const id = row?.internalId ?? null;
    refCache.set(key, id);
    return id;
  }

  /**
   * Create a record and its ref atomically. Returns the Source id, or the
   * existing one if a concurrent/replayed step already created it.
   */
  async function createWithRef(
    kind: RefKind,
    externalId: string,
    create: (tx: Prisma.TransactionClient) => Promise<{ id: string }>,
    created = true,
    sync?: Sync,
  ): Promise<string | null> {
    try {
      const id = await db.$transaction(async (tx) => {
        const record = await create(tx);
        await tx.importRef.create({
          data: {
            orgId,
            provider,
            kind,
            externalId: String(externalId),
            internalId: record.id,
            created,
            jobId,
            ...(sync ? syncData(sync) : {}),
          },
        });
        return record.id;
      });
      refCache.set(`${kind}:${externalId}`, id);
      bump(`${created ? 'created' : 'linked'}.${kind}`);
      return id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const target = String((err as Prisma.PrismaClientKnownRequestError).meta?.target ?? '');
      if (!target.includes('externalId')) throw err;
      refCache.delete(`${kind}:${externalId}`);
      return ref(kind, externalId);
    }
  }

  async function linkRef(kind: RefKind, externalId: string, internalId: string, created = false, sync?: Sync) {
    const inserted = await db.importRef
      .create({
        data: { orgId, provider, kind, externalId: String(externalId), internalId, created, jobId, ...(sync ? syncData(sync) : {}) },
      })
      .then(() => true)
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err;
        return false;
      });
    refCache.set(`${kind}:${externalId}`, internalId);
    if (inserted) bump(`${created ? 'created' : 'linked'}.${kind}`);
  }

  // ---------- re-imports ----------

  /** What a ref remembers of the vendor record: its hash and the Source values it mapped to. */
  type Sync = { fp: string; values: Record<string, unknown> };

  function syncData(sync: Sync) {
    return { fingerprint: sync.fp, snapshot: snapshotOf(sync.values) as Prisma.InputJsonValue, syncedAt: new Date() };
  }

  type PriorRef = {
    internalId: string;
    fingerprint: string | null;
    snapshot: Prisma.JsonValue;
    created: boolean;
    createdAt: Date;
    jobId: string | null;
    syncedAt: Date | null;
  };

  /** The ref of a record an earlier import (or step) brought in, or null for a new one. */
  async function priorRef(kind: RefKind, externalId: string): Promise<PriorRef | null> {
    const row = await db.importRef.findUnique({
      where: { orgId_provider_kind_externalId: { orgId, provider, kind, externalId: String(externalId) } },
      select: { internalId: true, fingerprint: true, snapshot: true, created: true, createdAt: true, jobId: true, syncedAt: true },
    });
    if (row) refCache.set(`${kind}:${externalId}`, row.internalId);
    return row;
  }

  /** Already created or brought up to date by this run: a second delivery is ignored. */
  function thisRun(prior: PriorRef): boolean {
    return prior.jobId === jobId || (!!deps.startedAt && !!prior.syncedAt && prior.syncedAt >= deps.startedAt);
  }

  /**
   * Mark an unchanged record as seen by this run (a small write on the ref,
   * none on the record), so a second delivery in the same run is ignored
   * rather than merged over the first.
   */
  async function touchRef(kind: RefKind, externalId: string) {
    await db.importRef.update({
      where: { orgId_provider_kind_externalId: { orgId, provider, kind, externalId: String(externalId) } },
      data: { syncedAt: new Date() },
    });
  }

  async function recordSync(kind: RefKind, externalId: string, sync: Sync) {
    await db.importRef.update({
      where: { orgId_provider_kind_externalId: { orgId, provider, kind, externalId: String(externalId) } },
      data: syncData(sync),
    });
  }

  /**
   * Bring a record imported before up to date (see resync.ts). An unchanged
   * vendor record costs nothing; a changed one is merged field by field
   * against the snapshot. A ref from before re-imports has no snapshot, and
   * `legacy` says what stands in for it: the record as it is now ('ours',
   * for records nobody edits in Orqestra), the same only if nothing has
   * updated it since the import did ('untouched'), or nothing ('unknown':
   * fields are only filled when empty).
   */
  async function resync<T extends Record<string, unknown>>(
    kind: RefKind,
    externalId: string,
    prior: PriorRef,
    sync: { fp: string; values: T },
    io: {
      read: () => Promise<{ ours: T; updatedAt?: Date | null } | null>;
      write: (update: Partial<T>) => Promise<unknown>;
      lists?: (keyof T)[];
      legacy: 'ours' | 'untouched' | 'unknown';
    },
  ): Promise<void> {
    if (!deps.updates || thisRun(prior)) return bump(`${kind}.existing`);
    if (prior.fingerprint === sync.fp) {
      await touchRef(kind, externalId);
      return bump(`unchanged.${kind}`);
    }
    const current = await io.read();
    // Deleted or erased in Orqestra since the last import: a tombstone.
    if (!current) return bump(`${kind}.gone`);
    let base = prior.snapshot as Partial<T> | null;
    if (!base && (io.legacy === 'ours' || (io.legacy === 'untouched' && prior.created && untouchedSince(current.updatedAt, prior.createdAt)))) {
      base = current.ours;
    }
    const { update, kept } = mergeRecord(base, current.ours, sync.values, { baseKnown: !!base, lists: io.lists });
    if (Object.keys(update).length) {
      await io.write(update);
      bump(`updated.${kind}`);
    } else bump(`unchanged.${kind}`);
    if (kept.length) bump(`kept.${kind}`);
    await recordSync(kind, externalId, sync);
  }

  // ---------- org configuration (loaded lazily, cached per slice) ----------

  let stageState: {
    byId: Map<string, { id: string; name: string; type: StageType }>;
    byName: Map<string, string>;
    byLoose: Map<string, string>;
  } | null = null;

  async function stages() {
    if (stageState) return stageState;
    const rows = await db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
    stageState = {
      byId: new Map(rows.map((s) => [s.id, s])),
      byName: new Map(rows.map((s) => [nameKey(s.name), s.id])),
      byLoose: new Map(rows.map((s) => [looseKey(s.name), s.id])),
    };
    return stageState;
  }

  /**
   * A stage the review didn't cover (seen only in data). It goes where its
   * type belongs in the pipeline; a concurrent stage edit is retried.
   */
  async function createStage(name: string, type: StageType = inferStageType(name)): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const ids = await db.$transaction((tx) => insertStages(tx, orgId, [{ name, type }]));
        stageState = null; // orders shifted; reload on next use
        bump('stage.created');
        return ids.get(nameKey(name))!;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 2) throw err;
        stageState = null;
      }
    }
  }

  /** Where hires go: the org's first Hired-type stage (created if it has none). */
  async function hiredStageId(): Promise<string> {
    const st = await stages();
    const hired = [...st.byId.values()].find((s) => s.type === 'HIRED');
    return hired ? hired.id : createStage('Hired', 'HIRED');
  }

  async function stageType(id: string): Promise<StageType | undefined> {
    return (await stages()).byId.get(id)?.type;
  }

  /** Vendor stage → Source stage id: ref → confirmed mapping → same name → new stage → default. */
  async function resolveStage(sref: StageRef | null | undefined): Promise<string> {
    const st = await stages();
    if (sref?.externalId) {
      const id = await ref('stage', sref.externalId);
      if (id && st.byId.has(id)) return id;
    }
    const name = sref?.name?.trim();
    if (name) {
      const key = nameKey(name);
      const mapped = deps.mapping.stages[key];
      if (mapped && st.byId.has(mapped)) return mapped;
      const same = st.byName.get(key) ?? st.byLoose.get(looseKey(name));
      if (same) return same;
      return createStage(name);
    }
    const fallback =
      [...st.byId.values()].find((s) => s.type === 'APPLICANT') ?? [...st.byId.values()][0];
    if (fallback) return fallback.id;
    return createStage('Imported');
  }

  let reasonState: Map<string, string> | null = null;
  let reasonIds: Set<string> | null = null;

  async function resolveReason(rref: ReasonRef | null | undefined): Promise<string | null> {
    if (!rref) return null;
    if (!reasonState || !reasonIds) {
      const rows = await db.archiveReason.findMany({ where: { orgId } });
      reasonState = new Map(rows.map((r) => [looseKey(r.name), r.id]));
      reasonIds = new Set(rows.map((r) => r.id));
    }
    if (rref.externalId) {
      const id = await ref('reason', rref.externalId);
      if (id && reasonIds.has(id)) return id;
    }
    const name = rref.name?.trim();
    if (!name) return null;
    const key = nameKey(name);
    const mapped = deps.mapping.reasons[key];
    if (mapped && reasonIds.has(mapped)) return mapped;
    const same = reasonState.get(looseKey(name));
    if (same) return same;
    const reason = await db.archiveReason.create({
      // Unmapped reason seen only in data: withdrawals and hires aren't rejections.
      data: { orgId, name, countsAsRejection: !/\bhired\b|withdr[ae]w|declined/i.test(name) },
    });
    reasonState.set(looseKey(name), reason.id);
    reasonIds.add(reason.id);
    bump('reason.created');
    return reason.id;
  }

  async function resolveUser(externalUserId: string | null | undefined): Promise<string | null> {
    return ref('user', externalUserId);
  }

  /** Author for notes/feedback: the matched teammate, else the importer with the original name kept. */
  async function resolveAuthor(externalUserId: string | null | undefined, authorName: string | null | undefined) {
    const userId = await resolveUser(externalUserId);
    if (userId) return { authorId: userId, byline: '' };
    const who = authorName?.trim();
    return {
      authorId: deps.fallbackAuthorId,
      byline: `[${deps.providerName}${who ? ` · ${who}` : ''}] `,
    };
  }

  // ---------- parents ----------

  const alive = new Map<string, boolean>();

  /** A ref's target may have been deleted in Orqestra since; link to it only if it's still there. */
  async function existing(kind: 'posting' | 'requisition', id: string | null): Promise<string | null> {
    if (!id) return null;
    const key = `${kind}:${id}`;
    if (!alive.has(key)) {
      const found =
        kind === 'posting'
          ? await db.posting.findFirst({ where: { id, orgId }, select: { id: true } })
          : await db.requisition.findFirst({ where: { id, orgId }, select: { id: true } });
      alive.set(key, !!found);
    }
    return alive.get(key) ? id : null;
  }

  const contactInfo = new Map<string, { resumeFileId: string | null; isAnonymized: boolean; resumeText: boolean } | null>();

  async function contactState(contactId: string) {
    if (contactInfo.has(contactId)) return contactInfo.get(contactId)!;
    const c = await db.contact.findFirst({
      where: { id: contactId, orgId },
      select: { resumeFileId: true, isAnonymized: true, resumeText: true },
    });
    const info = c ? { resumeFileId: c.resumeFileId, isAnonymized: c.isAnonymized, resumeText: !!c.resumeText } : null;
    contactInfo.set(contactId, info);
    return info;
  }

  const opportunityOk = new Map<string, boolean>();

  /** Opportunity id for a child record, or null (not imported, deleted, or erased). */
  async function parentOpportunity(applicationExternalId: string | null | undefined): Promise<string | null> {
    const id = await ref('opportunity', applicationExternalId);
    if (!id) return null;
    if (!opportunityOk.has(id)) {
      const opp = await db.opportunity.findFirst({
        where: { id, orgId },
        select: { contact: { select: { isAnonymized: true } } },
      });
      opportunityOk.set(id, !!opp && !opp.contact.isAnonymized);
    }
    return opportunityOk.get(id) ? id : null;
  }

  /** Whether a file came in with an earlier run of this import (not this one, and not from elsewhere). */
  async function importedEarlier(fileId: string): Promise<boolean> {
    return !!(await db.importRef.findFirst({
      // OR null: `jobId <> x` is never true for a ref with no job (an org import).
      where: { orgId, provider, kind: 'file', internalId: fileId, OR: [{ jobId: null }, { jobId: { not: jobId } }] },
      select: { id: true },
    }));
  }

  /** Candidate-level records (notes, files) land on the candidate's most recent opportunity. */
  async function latestOpportunityFor(candidateExternalId: string | null | undefined): Promise<string | null> {
    const contactId = await ref('contact', candidateExternalId);
    if (!contactId) return null;
    const opp = await db.opportunity.findFirst({
      where: { orgId, contactId, contact: { isAnonymized: false } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return opp?.id ?? null;
  }

  function beforeSince(date: Date | null | undefined): boolean {
    return !!(deps.since && date && date < deps.since);
  }

  // ---------- records ----------

  /** The Source values a vendor candidate maps to: what a contact is created with, and later merged from. */
  function contactValues(c: ImportedCandidate) {
    return {
      name: clip(c.name.trim() || 'Unknown candidate', 200),
      headline: c.headline ? clip(c.headline, 300) : null,
      location: c.location ? clip(c.location, 200) : null,
      // Orqestra stores emails lowercased; matching and dedupe rely on it.
      emails: [...new Set(c.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))],
      phones: c.phones,
      links: c.links,
      tags: c.tags ?? [],
    };
  }

  async function createContact(c: ImportedCandidate): Promise<string | null> {
    const existing = await ref('contact', c.externalId);
    if (existing) return existing;
    const values = contactValues(c);
    const sync = { fp: fingerprint(c), values };

    // Someone who applied directly, or came from a CSV, is the same person.
    // `&&` over the GIN index on emails keeps this one indexed lookup however
    // large the org is.
    const { emails } = values;
    if (emails.length) {
      // No LIMIT: with one, Postgres walks the org's contacts instead of the index.
      const [match] = await db.$queryRaw<{ id: string; emails: string[]; tags: string[]; phones: string[]; links: string[] }[]>`
        SELECT id, emails, tags, phones, links FROM "Contact"
        WHERE emails && ${emails}::text[] AND "orgId" = ${orgId} AND "isAnonymized" = false`;
      if (match) {
        const union = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];
        await db.contact.update({
          where: { id: match.id },
          data: {
            emails: union(match.emails, emails),
            tags: union(match.tags, c.tags),
            phones: union(match.phones, c.phones),
            links: union(match.links, c.links),
          },
        });
        await linkRef('contact', c.externalId, match.id, false, sync);
        return match.id;
      }
    }

    return createWithRef(
      'contact',
      c.externalId,
      (tx) => tx.contact.create({ data: { orgId, ...values, createdAt: c.createdAt ?? undefined }, select: { id: true } }),
      true,
      sync,
    );
  }

  /**
   * A candidate imported before. Only what the vendor changed is taken, and
   * contact details only grow. There's no safe "untouched" test for a
   * contact (resume parsing and the resume-text cron update them too), so a
   * ref from before re-imports only fills empty fields.
   */
  async function resyncContact(prior: PriorRef, c: ImportedCandidate) {
    await resync('contact', c.externalId, prior, { fp: fingerprint(c), values: contactValues(c) }, {
      legacy: 'unknown',
      lists: ['emails', 'phones', 'links', 'tags'],
      read: async () => {
        const row = await db.contact.findFirst({
          where: { id: prior.internalId, orgId, isAnonymized: false },
          select: { name: true, headline: true, location: true, emails: true, phones: true, links: true, tags: true },
        });
        return row ? { ours: row } : null;
      },
      write: (update) => db.contact.update({ where: { id: prior.internalId }, data: update }),
    });
  }

  const departments = new Map<string, string>();

  async function departmentId(name: string | null | undefined): Promise<string | null> {
    if (!name?.trim() || deps.orgKind !== 'COMPANY') return null;
    const clean = name.trim().slice(0, 120);
    const key = clean.toLowerCase();
    if (departments.has(key)) return departments.get(key)!;
    const dept = await db.department.upsert({
      where: { orgId_name: { orgId, name: clean } },
      create: { orgId, name: clean },
      update: {},
      select: { id: true },
    });
    departments.set(key, dept.id);
    return dept.id;
  }

  /**
   * Where a vendor application sits in Orqestra: stage, status, archive reason
   * and date, and the stage history leading there (oldest first, the last
   * move into the current stage).
   */
  async function placementOf(a: ImportedApplication) {
    let stageId = await resolveStage(a.stage);
    let status: 'ACTIVE' | 'ARCHIVED' | 'HIRED' =
      a.status === 'hired' ? 'HIRED' : a.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
    // In Source a hire sits in a Hired-type stage (reports and the pipeline
    // read it that way), and anything in that stage counts as hired.
    if (status === 'ACTIVE' && (await stageType(stageId)) === 'HIRED') status = 'HIRED';
    const archiveReasonId = status === 'ARCHIVED' ? await resolveReason(a.archiveReason) : null;
    const createdAt = a.createdAt ?? new Date();

    const history: { stageId: string; at: Date; actorId: string | null }[] = [];
    for (const h of [...(a.history ?? [])].sort((x, y) => x.at.getTime() - y.at.getTime())) {
      history.push({
        stageId: await resolveStage(h.stage),
        at: h.at,
        actorId: await resolveUser(h.actorExternalUserId),
      });
    }
    // Collapse consecutive moves into the same Source stage (two vendor stages mapped to one).
    const transitions = history.filter((h, i) => i === 0 || h.stageId !== history[i - 1].stageId);
    // Reports build the funnel from transitions: every application needs at
    // least one, and the last must be the current stage.
    const last = transitions[transitions.length - 1];
    if (!last) transitions.push({ stageId, at: createdAt, actorId: null });
    else if (last.stageId !== stageId) transitions.push({ stageId, at: new Date(last.at.getTime() + 1), actorId: null });
    if (status === 'HIRED' && (await stageType(stageId)) !== 'HIRED') {
      const prev = transitions[transitions.length - 1].at;
      const hiredAt = a.archivedAt && a.archivedAt > prev ? a.archivedAt : new Date(prev.getTime() + 1);
      stageId = await hiredStageId();
      transitions.push({ stageId, at: hiredAt, actorId: null });
    }
    const lastMove = transitions[transitions.length - 1].at;
    // Like a hire made in Orqestra: no archive date or reason, just the Hired stage.
    const archivedAt = status === 'ARCHIVED' ? (a.archivedAt ?? lastMove) : null;
    return { stageId, status, archiveReasonId, archivedAt, transitions, lastMove };
  }

  /** An application's other imported fields. */
  async function applicationValues(a: ImportedApplication) {
    let postingId: string | null = null;
    if (a.postingExternalId) {
      postingId = await existing('posting', await ref('posting', a.postingExternalId));
      if (!postingId) {
        bump('opportunity.postingMissing');
        warnOnce('app-no-posting', 'Some applications point at jobs that were not imported; they were kept without a posting');
      }
    }
    return {
      postingId,
      ownerId: await resolveUser(a.ownerExternalUserId),
      source: a.source ? clip(a.source, 200) : null,
      confidential: a.confidential ?? false,
      imported: {
        provider,
        id: a.externalId,
        ...(a.fields && Object.keys(a.fields).length ? { fields: a.fields } : {}),
      } as Record<string, unknown>,
    };
  }

  type Placement = Awaited<ReturnType<typeof placementOf>>;
  type AppValues = Awaited<ReturnType<typeof applicationValues>>;

  /** An application's merged fields; the placement is one value, since it moves as a whole. */
  function applicationFields(place: Placement, values: AppValues) {
    return {
      placement: { stageId: place.stageId, status: place.status, archiveReasonId: place.archiveReasonId, archivedAt: place.archivedAt },
      ownerId: values.ownerId,
      postingId: values.postingId,
      source: values.source,
      confidential: values.confidential,
      imported: values.imported,
    };
  }

  /** What an application's ref remembers: its fields, and when the last imported move was. */
  const applicationSync = (a: ImportedApplication, place: Placement, values: AppValues) => ({
    fp: fingerprint(a),
    values: { ...applicationFields(place, values), lastMoveAt: place.lastMove },
  });

  /**
   * An application imported before. If the vendor moved it (or archived,
   * unarchived or hired it) and nobody moved it in Orqestra since, it follows,
   * and the vendor's moves since the last import are added to its history.
   * If someone moved it in Orqestra, their move stands.
   */
  async function resyncApplication(prior: PriorRef, a: ImportedApplication) {
    if (!deps.updates || thisRun(prior)) return bump('opportunity.existing');
    const fp = fingerprint(a);
    if (prior.fingerprint === fp) {
      await touchRef('opportunity', a.externalId);
      return bump('unchanged.opportunity');
    }
    const opp = await db.opportunity.findFirst({
      where: { id: prior.internalId, orgId },
      select: {
        stageId: true, status: true, archiveReasonId: true, archivedAt: true, ownerId: true, postingId: true,
        source: true, confidential: true, customFields: true, stageChangedAt: true, updatedAt: true,
        contact: { select: { isAnonymized: true } },
      },
    });
    if (!opp || opp.contact.isAnonymized) return bump('opportunity.gone');

    const place = await placementOf(a);
    const values = await applicationValues(a);
    const theirs = applicationFields(place, values);
    const custom = opp.customFields && typeof opp.customFields === 'object' && !Array.isArray(opp.customFields)
      ? (opp.customFields as Record<string, unknown>)
      : {};
    const ours = {
      placement: { stageId: opp.stageId, status: opp.status, archiveReasonId: opp.archiveReasonId, archivedAt: opp.archivedAt },
      ownerId: opp.ownerId,
      postingId: opp.postingId,
      source: opp.source,
      confidential: opp.confidential,
      imported: (custom.imported ?? null) as Record<string, unknown> | null,
    };
    let base = prior.snapshot as (typeof theirs & { lastMoveAt?: string }) | null;
    let lastImportedMove = base?.lastMoveAt ? new Date(base.lastMoveAt) : null;
    if (!base && prior.created && untouchedSince(opp.updatedAt, prior.createdAt)) {
      base = ours as typeof theirs;
      lastImportedMove = opp.stageChangedAt;
    }
    const { update, kept } = mergeRecord(base, ours as typeof theirs, theirs, { baseKnown: !!base });

    const data: Prisma.OpportunityUncheckedUpdateInput = {};
    if ('ownerId' in update) data.ownerId = update.ownerId;
    if ('postingId' in update) data.postingId = update.postingId;
    if ('source' in update) data.source = update.source;
    if ('confidential' in update) data.confidential = update.confidential;
    if ('imported' in update) data.customFields = { ...custom, imported: update.imported } as Prisma.InputJsonValue;

    const moves: { fromStageId: string; toStageId: string; actorId: string | null; occurredAt: Date }[] = [];
    if ('placement' in update) {
      let from = opp.stageId;
      let lastAt = opp.stageChangedAt;
      for (const t of place.transitions) {
        if (lastImportedMove && t.at <= lastImportedMove) continue;
        if (t.stageId === from) continue;
        moves.push({ fromStageId: from, toStageId: t.stageId, actorId: t.actorId, occurredAt: t.at });
        from = t.stageId;
        lastAt = t.at;
      }
      if (from !== place.stageId) {
        // The vendor sent no dated move into the new stage.
        lastAt = new Date(Math.max(Date.now(), lastAt.getTime() + 1));
        moves.push({ fromStageId: from, toStageId: place.stageId, actorId: null, occurredAt: lastAt });
      }
      Object.assign(data, {
        stageId: place.stageId,
        status: place.status,
        archiveReasonId: place.archiveReasonId,
        archivedAt: place.archivedAt,
        ...(moves.length ? { stageChangedAt: lastAt } : {}),
      });
    }

    if (Object.keys(data).length) {
      await db.$transaction(async (tx) => {
        await tx.opportunity.update({ where: { id: prior.internalId }, data });
        if (moves.length) await tx.stageTransition.createMany({ data: moves.map((m) => ({ opportunityId: prior.internalId, ...m })) });
      });
      bump('updated.opportunity');
    } else bump('unchanged.opportunity');
    if (kept.length) bump('kept.opportunity');
    await recordSync('opportunity', a.externalId, applicationSync(a, place, values));
  }

  const warnedOnce = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    deps.warn(message);
  };

  const loader: Loader = {
    async has(kind, externalId) {
      return !!(await ref(kind, externalId));
    },

    async handled(kind, externalId) {
      const prior = await priorRef(kind, externalId);
      return !!prior && thisRun(prior);
    },

    async requisition(r: ImportedRequisition) {
      r = scrub(r);
      const code = clip(r.code.trim() || r.externalId, 60);
      const values = {
        title: clip(r.title.trim() || code, 200),
        state: (r.state === 'open' ? 'OPEN' : r.state === 'on_hold' ? 'ON_HOLD' : 'CLOSED') as RequisitionState,
        openings: Math.max(0, int32(r.openings) ?? 1),
        filled: Math.max(0, int32(r.filled) ?? 0),
        backfill: r.backfill ?? false,
        salaryMin: int32(r.salaryMin),
        salaryMax: int32(r.salaryMax),
        salaryCurrency: r.salaryCurrency || 'USD',
      };
      const sync = { fp: fingerprint(r), values };
      const prior = await priorRef('requisition', r.externalId);
      if (prior) {
        return resync('requisition', r.externalId, prior, sync, {
          legacy: 'untouched',
          read: async () => {
            const row = await db.requisition.findFirst({
              where: { id: prior.internalId, orgId },
              select: { title: true, state: true, openings: true, filled: true, backfill: true, salaryMin: true, salaryMax: true, salaryCurrency: true, updatedAt: true },
            });
            if (!row) return null;
            const { updatedAt, ...ours } = row;
            return { ours, updatedAt };
          },
          write: (update) => db.requisition.update({ where: { id: prior.internalId }, data: update }),
        });
      }
      const same = await db.requisition.findUnique({ where: { orgId_code: { orgId, code } }, select: { id: true } });
      if (same) {
        await linkRef('requisition', r.externalId, same.id, false, sync);
        return bump('requisition.linked');
      }
      await createWithRef('requisition', r.externalId, (tx) => tx.requisition.create({ data: { orgId, code, ...values }, select: { id: true } }), true, sync);
    },

    async posting(p: ImportedPosting) {
      p = scrub(p);
      const title = clip(p.title.trim() || 'Imported posting', 200);
      const [deptId, requisitionId] = await Promise.all([
        departmentId(p.department),
        ref('requisition', p.requisitionExternalId).then((id) => existing('requisition', id)),
      ]);
      const values = {
        title,
        // Nothing goes live by accident: open roles arrive as drafts to publish deliberately.
        state: (p.state === 'closed' ? 'CLOSED' : 'DRAFT') as PostingState,
        departmentId: deptId,
        requisitionId,
        location: p.location ? clip(p.location, 200) : null,
        workplaceType: p.workplaceType ?? 'ONSITE',
        commitment: p.commitment ?? 'FULL_TIME',
        salaryMin: int32(p.salaryMin),
        salaryMax: int32(p.salaryMax),
        salaryCurrency: p.salaryCurrency || null,
        description: p.description ? clip(p.description, 50_000) : null,
        tags: p.tags ?? [],
      };
      const sync = { fp: fingerprint(p), values };
      const prior = await priorRef('posting', p.externalId);
      if (prior) {
        let content: Record<string, unknown> = {};
        return resync('posting', p.externalId, prior, sync, {
          legacy: 'untouched',
          lists: ['tags'],
          read: async () => {
            const row = await db.posting.findFirst({
              where: { id: prior.internalId, orgId },
              select: {
                title: true, state: true, departmentId: true, requisitionId: true, location: true, workplaceType: true,
                commitment: true, salaryMin: true, salaryMax: true, salaryCurrency: true, content: true, tags: true, updatedAt: true,
              },
            });
            if (!row) return null;
            const { updatedAt, content: raw, ...rest } = row;
            content = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
            const description = typeof content.description === 'string' ? content.description : null;
            return { ours: { ...rest, description }, updatedAt };
          },
          write: ({ description, ...update }) =>
            db.posting.update({
              where: { id: prior.internalId },
              data: { ...update, ...(description !== undefined ? { content: { ...content, description } as Prisma.InputJsonValue } : {}) },
            }),
        });
      }
      const slug = externalSlug(title, provider, p.externalId);
      const same = await db.posting.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true } });
      if (same) {
        await linkRef('posting', p.externalId, same.id, false, sync);
        return bump('posting.linked');
      }
      const { description, ...columns } = values;
      await createWithRef(
        'posting',
        p.externalId,
        (tx) =>
          tx.posting.create({
            data: {
              orgId,
              slug,
              ...columns,
              content: description ? { description } : undefined,
              createdAt: p.createdAt ?? undefined,
            },
            select: { id: true },
          }),
        true,
        sync,
      );
    },

    async candidate(c: ImportedCandidate) {
      c = scrub(c);
      const prior = await priorRef('contact', c.externalId);
      if (prior) return resyncContact(prior, c);
      if (beforeSince(c.createdAt)) return bump('contact.beforeSince');
      await createContact(c);
    },

    async application(a: ImportedApplication) {
      a = scrub(a);
      const prior = await priorRef('opportunity', a.externalId);
      if (prior) return resyncApplication(prior, a);
      if (!options.archived && a.status !== 'active') return bump('opportunity.archivedSkipped');
      if (beforeSince(a.createdAt)) return bump('opportunity.beforeSince');

      const contactId =
        (await ref('contact', a.candidateExternalId)) ?? (a.candidate ? await createContact(a.candidate) : null);
      if (!contactId) {
        bump('opportunity.noCandidate');
        return warnOnce('app-no-candidate', 'Some applications referenced candidates that could not be imported');
      }
      const contact = await contactState(contactId);
      if (!contact || contact.isAnonymized) return bump('opportunity.erasedCandidate');

      const place = await placementOf(a);
      const values = await applicationValues(a);
      const createdAt = a.createdAt ?? new Date();

      const id = await createWithRef(
        'opportunity',
        a.externalId,
        async (tx) => {
          const opp = await tx.opportunity.create({
            data: {
              orgId,
              contactId,
              postingId: values.postingId,
              stageId: place.stageId,
              status: place.status,
              origin: a.origin ?? 'APPLIED',
              source: values.source,
              archiveReasonId: place.archiveReasonId,
              archivedAt: place.archivedAt,
              ownerId: values.ownerId,
              confidential: values.confidential,
              customFields: { imported: values.imported } as Prisma.InputJsonValue,
              stageChangedAt: place.lastMove,
              createdAt,
            },
            select: { id: true },
          });
          let from: string | null = null;
          if (place.transitions.length) {
            await tx.stageTransition.createMany({
              data: place.transitions.map((t) => {
                const row = { opportunityId: opp.id, fromStageId: from, toStageId: t.stageId, actorId: t.actorId, occurredAt: t.at };
                from = t.stageId;
                return row;
              }),
            });
          }
          return opp;
        },
        true,
        applicationSync(a, place, values),
      );
      if (id) opportunityOk.set(id, true);
    },

    async note(n: ImportedNote) {
      n = scrub(n);
      if (!options.activity) return;
      const body = n.body?.trim();
      const prior = await priorRef('note', n.externalId);
      if (!body) return bump('note.empty');
      const { authorId, byline } = await resolveAuthor(n.authorExternalUserId, n.authorName);
      const values = { body: clip(`${byline}${body}`) };
      const sync = { fp: fingerprint(n), values };
      if (prior) {
        // Notes can't be edited in Orqestra, so an old ref's note is as the import wrote it.
        return resync('note', n.externalId, prior, sync, {
          legacy: 'ours',
          read: async () => {
            const row = await db.note.findFirst({ where: { id: prior.internalId, orgId, opportunity: { contact: { isAnonymized: false } } }, select: { body: true } });
            return row ? { ours: row } : null;
          },
          write: (update) => db.note.update({ where: { id: prior.internalId }, data: update }),
        });
      }
      const opportunityId = n.applicationExternalId
        ? await parentOpportunity(n.applicationExternalId)
        : await latestOpportunityFor(n.candidateExternalId);
      if (!opportunityId) return bump('note.noParent');
      await createWithRef(
        'note',
        n.externalId,
        (tx) => tx.note.create({ data: { orgId, opportunityId, authorId, ...values, createdAt: n.createdAt ?? undefined }, select: { id: true } }),
        true,
        sync,
      );
    },

    async interview(i: ImportedInterview) {
      i = scrub(i);
      if (!options.activity) return;
      const values = {
        title: clip(i.title.trim() || 'Interview', 200),
        startAt: i.startAt,
        durationMins: i.durationMins && i.durationMins > 0 ? Math.min(int32(i.durationMins)!, 24 * 60) : 60,
        location: i.location ? clip(i.location, 500) : null,
        state: (i.state === 'canceled'
          ? 'CANCELED'
          : i.state === 'completed' || (i.state == null && i.startAt < new Date())
            ? 'COMPLETED'
            : 'SCHEDULED') as InterviewState,
      };
      const sync = { fp: fingerprint(i), values };
      const prior = await priorRef('interview', i.externalId);
      if (prior) {
        return resync('interview', i.externalId, prior, sync, {
          legacy: 'untouched',
          read: async () => {
            const row = await db.interview.findFirst({
              where: { id: prior.internalId, orgId, opportunity: { contact: { isAnonymized: false } } },
              select: { title: true, startAt: true, durationMins: true, location: true, state: true, updatedAt: true },
            });
            if (!row) return null;
            const { updatedAt, ...ours } = row;
            return { ours, updatedAt };
          },
          write: (update) => db.interview.update({ where: { id: prior.internalId }, data: update }),
        });
      }
      const opportunityId = await parentOpportunity(i.applicationExternalId);
      if (!opportunityId) return bump('interview.noParent');
      const panelists = (
        await Promise.all((i.panelistExternalUserIds ?? []).map((uid) => resolveUser(uid)))
      ).filter((x): x is string => !!x);
      await createWithRef(
        'interview',
        i.externalId,
        (tx) =>
          tx.interview.create({
            data: {
              orgId,
              opportunityId,
              ...values,
              panelists: panelists.length ? { connect: [...new Set(panelists)].map((id) => ({ id })) } : undefined,
            },
            select: { id: true },
          }),
        true,
        sync,
      );
    },

    async feedback(f: ImportedFeedback) {
      f = scrub(f);
      if (!options.activity) return;
      const { authorId, byline } = await resolveAuthor(f.authorExternalUserId, f.authorName);
      const lines = (f.answers ?? [])
        .filter((q) => q.value?.trim())
        .map((q) => `${q.label}: ${q.value.trim()}`);
      const summaryText = [f.title?.trim(), f.summary?.trim(), ...lines].filter(Boolean).join('\n');
      const answers = Object.fromEntries(
        (f.answers ?? [])
          .filter((q) => q.value?.trim())
          .map((q, idx) => [`imported-${idx}`, { label: clip(q.label, 300), kind: 'TEXT', value: clip(q.value.trim(), 4000) }]),
      );
      const scorecard = {
        summary: clip(`${byline}${[f.title?.trim(), f.summary?.trim()].filter(Boolean).join('\n') || 'Imported scorecard'}`, 8000),
        answers: (Object.keys(answers).length ? answers : null) as Prisma.JsonValue,
      };

      const prior = await priorRef('feedback', f.externalId);
      if (prior && !deps.updates) return bump('feedback.existing');
      if (prior) {
        // Imported as a note (no overall decision at the time) or as a scorecard;
        // neither can be edited in Orqestra, so an old ref's record is as written.
        const note = await db.note.findFirst({ where: { id: prior.internalId, orgId, opportunity: { contact: { isAnonymized: false } } }, select: { body: true } });
        if (note) {
          if (!summaryText) return bump('feedback.empty');
          return resync('feedback', f.externalId, prior, { fp: fingerprint(f), values: { body: clip(`${byline}${summaryText}`) } }, {
            legacy: 'ours',
            read: async () => ({ ours: note }),
            write: (update) => db.note.update({ where: { id: prior.internalId }, data: update }),
          });
        }
        const values = { ...scorecard, ...(f.rating != null ? { overallRating: f.rating } : {}) };
        return resync('feedback', f.externalId, prior, { fp: fingerprint(f), values }, {
          legacy: 'ours',
          read: async () => {
            const row = await db.feedbackSubmission.findFirst({
              where: { id: prior.internalId, orgId, opportunity: { contact: { isAnonymized: false } } },
              select: { summary: true, answers: true, overallRating: true },
            });
            return row ? { ours: { summary: row.summary, answers: row.answers, ...(f.rating != null ? { overallRating: row.overallRating } : {}) } } : null;
          },
          write: ({ answers: nextAnswers, ...update }) =>
            db.feedbackSubmission.update({
              where: { id: prior.internalId },
              data: { ...update, ...(nextAnswers !== undefined ? { answers: nextAnswers ?? Prisma.DbNull } : {}) },
            }),
        });
      }

      const opportunityId = await parentOpportunity(f.applicationExternalId);
      if (!opportunityId) return bump('feedback.noParent');

      if (f.rating == null) {
        // A scorecard with no overall decision is still worth reading — keep it as a note.
        if (!summaryText) return bump('feedback.empty');
        bump('feedback.asNote');
        const values = { body: clip(`${byline}${summaryText}`) };
        await createWithRef(
          'feedback',
          f.externalId,
          (tx) => tx.note.create({ data: { orgId, opportunityId, authorId, ...values, createdAt: f.createdAt ?? undefined }, select: { id: true } }),
          true,
          { fp: fingerprint(f), values },
        );
        return;
      }

      const interviewId = await ref('interview', f.interviewExternalId);
      const values = { ...scorecard, overallRating: f.rating };
      await createWithRef(
        'feedback',
        f.externalId,
        (tx) =>
          tx.feedbackSubmission.create({
            data: {
              orgId,
              opportunityId,
              interviewId,
              authorId,
              overallRating: f.rating!,
              summary: scorecard.summary,
              answers: scorecard.answers ?? undefined,
              createdAt: f.createdAt ?? undefined,
            },
            select: { id: true },
          }),
        true,
        { fp: fingerprint(f), values },
      );
    },

    async offer(o: ImportedOffer) {
      o = scrub(o);
      if (!options.offers) return;
      const prior = await priorRef('offer', o.externalId);
      if (prior && !deps.updates) return bump('offer.existing');
      const opportunityId = prior ? null : await parentOpportunity(o.applicationExternalId);
      if (!prior && !opportunityId) return bump('offer.noParent');
      let jobTitle = o.jobTitle?.trim();
      if (!jobTitle) {
        const opp = await db.opportunity.findFirst({
          where: { id: opportunityId ?? (await ref('opportunity', o.applicationExternalId)) ?? '', orgId },
          select: { posting: { select: { title: true } } },
        });
        jobTitle = opp?.posting?.title ?? 'Imported offer';
      }
      const values = {
        // An offer waiting on approval in the old system has no approval request
        // here; as a draft it can be picked up and sent through Orqestra's flow.
        status: (o.status === 'PENDING_APPROVAL' ? 'DRAFT' : o.status) as OfferStatus,
        jobTitle: clip(jobTitle, 200),
        salaryAmount: int32(o.salaryAmount),
        salaryCurrency: o.salaryCurrency?.trim().toUpperCase().slice(0, 3) || 'USD',
        equity: o.equity ? clip(o.equity, 200) : null,
        startDate: o.startDate ?? null,
        sentAt: o.sentAt ?? null,
        respondedAt: o.respondedAt ?? null,
        notes: o.notes ? clip(o.notes, 4000) : null,
      };
      const sync = { fp: fingerprint(o), values };
      if (prior) {
        return resync('offer', o.externalId, prior, sync, {
          legacy: 'untouched',
          read: async () => {
            const row = await db.offer.findFirst({
              where: { id: prior.internalId, orgId, opportunity: { contact: { isAnonymized: false } } },
              select: {
                status: true, jobTitle: true, salaryAmount: true, salaryCurrency: true, equity: true,
                startDate: true, sentAt: true, respondedAt: true, notes: true, updatedAt: true,
              },
            });
            if (!row) return null;
            const { updatedAt, ...ours } = row;
            return { ours, updatedAt };
          },
          write: (update) => db.offer.update({ where: { id: prior.internalId }, data: update }),
        });
      }
      await createWithRef(
        'offer',
        o.externalId,
        (tx) =>
          tx.offer.create({
            data: {
              orgId,
              opportunityId: opportunityId!,
              ...values,
              // Drafts can be sent from Orqestra, which needs the candidate link token.
              token: values.status === 'DRAFT' ? randomBytes(24).toString('base64url') : null,
              createdAt: o.createdAt ?? undefined,
            },
            select: { id: true },
          }),
        true,
        sync,
      );
    },

    async file(f: ImportedFile) {
      f = scrub(f);
      if (!options.files) return;
      if (!fileStorageAvailable()) {
        bump('file.noStorage');
        return warnOnce('no-storage', 'File storage is not configured on this deployment (connect an R2 or other S3-compatible bucket — see .env.example), so resumes were skipped');
      }
      if (await ref('file', f.externalId)) return bump('file.existing');
      const contactId = await ref('contact', f.candidateExternalId);
      if (!contactId) return bump('file.noParent');
      const contact = await contactState(contactId);
      if (!contact || contact.isAnonymized) return bump('file.erasedCandidate');

      // Anything that isn't the primary resume is reached through a note on an
      // application. With no application yet, leave it for a later run. On a
      // re-import, a resume the vendor didn't have last time is newer than
      // the one that import set, and replaces it; a resume from anywhere else
      // (the careers page, a re-application) stays.
      const replaces =
        !!deps.updates && f.kind === 'resume' && !!contact.resumeFileId && (await importedEarlier(contact.resumeFileId));
      const asResume = f.kind === 'resume' && (!contact.resumeFileId || replaces);
      let opportunityId: string | null = null;
      if (!asResume) {
        opportunityId = f.applicationExternalId
          ? await parentOpportunity(f.applicationExternalId)
          : await latestOpportunityFor(f.candidateExternalId);
        if (!opportunityId) return bump('file.noApplication');
      }

      let downloaded;
      try {
        downloaded = await f.download();
      } catch (err) {
        // One file the vendor won't serve (expired link, per-file permission)
        // is that file's problem, not the import's.
        if (err instanceof ImportHttpError || (err instanceof ImportAuthError && err.status === 403)) {
          bump('file.downloadFailed');
          deps.warn(`Couldn't download ${f.filename}: ${err.message}`, { entity: 'file', externalId: f.externalId });
          return;
        }
        throw err;
      }
      const filename = clip(scrub(downloaded.filename || f.filename || 'file').replace(/[/\\]/g, '_'), 200);
      const mime = safeMime(downloaded.contentType, filename);

      // A stable key per vendor file: a replayed step overwrites its own bytes
      // instead of leaving an orphan, and the rows below commit together.
      // Keyed with the app secret: Blob URLs are public, so the path must not be derivable.
      const stable = createHmac('sha256', process.env.AUTH_SECRET || 'source-import')
        .update(`${orgId}:${provider}:${f.externalId}`)
        .digest('hex')
        .slice(0, 32);
      const key = `${orgId}/import-${stable}-${filename.replace(/[^\w.\-]+/g, '_').slice(0, 100)}`;
      await putFileBytes(key, downloaded.data, mime);
      // Any format we can read, sniffed from the bytes (the served type above
      // stays narrow). A file over MAX_EXTRACT_BYTES comes back TOO_LARGE
      // unparsed, and one that fails is retried by the resume-text cron.
      const extracted = asResume ? await extractText({ data: downloaded.data, source: 'import', timeoutMs: 10_000 }) : null;
      const text = extracted?.text ?? null;

      try {
        const storedId = await db.$transaction(async (tx) => {
          const stored = await tx.storedFile.create({
            data: {
              orgId,
              key,
              filename,
              mime,
              size: downloaded.data.byteLength,
              contactId,
              ...(extracted ? textFields(extracted, new Date()) : {}),
            },
            select: { id: true },
          });
          if (asResume) {
            await tx.contact.update({
              where: { id: contactId },
              // The text goes with its file: a replaced resume's text is cleared,
              // and the resume-text cron retries one that couldn't be read now.
              data: { resumeFileId: stored.id, ...(replaces ? { resumeText: text } : text && !contact.resumeText ? { resumeText: text } : {}) },
            });
          } else {
            await tx.note.create({
              data: {
                orgId,
                opportunityId: opportunityId!,
                authorId: deps.fallbackAuthorId,
                // Retention deletes this note along with the file (the name is often the candidate's).
                body: `[${deps.providerName}] Attachment: ${filename} — /api/files/${stored.id}`,
              },
            });
          }
          await tx.importRef.create({
            data: { orgId, provider, kind: 'file', externalId: String(f.externalId), internalId: stored.id, created: true, jobId },
          });
          return stored.id;
        });
        refCache.set(`file:${f.externalId}`, storedId);
        bump('created.file');
        if (asResume) {
          contact.resumeFileId = storedId;
          contact.resumeText = !!text || (!replaces && contact.resumeText);
          bump(replaces ? 'file.resumeReplaced' : 'file.resume');
        } else {
          bump('file.attachment');
        }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // a replay beat us to it
      }
    },
  };

  return loader;
}
