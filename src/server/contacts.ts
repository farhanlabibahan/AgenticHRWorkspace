import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { parseCsv } from '@/lib/csv';
import { capName } from '@/lib/utils';
import { invalidateContactCounts, invalidateLists } from '@/server/lists/cache';
import { textPending } from '@/server/text/status';

/**
 * Contact-level CRM operations: tags, duplicate detection + merge, CSV
 * import, and cross-record search. Opportunity workflow lives in
 * opportunities.ts — this file is about the person record itself.
 */

export async function setContactTags(
  ctx: SessionContext,
  contactId: string,
  tags: string[],
  { invalidate = true }: { invalidate?: boolean } = {},
) {
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 30);
  const updated = await db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { id: contactId, orgId: ctx.orgId } });
    if (!contact) throw new Error('Contact not found');
    const updated = await tx.contact.update({ where: { id: contact.id }, data: { tags: clean } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'contact.tagged',
      subjectType: 'contact',
      subjectId: contact.id,
      payload: { tags: clean },
    });
    return updated;
  });
  if (invalidate) invalidateContactCounts(ctx.orgId);
  return updated;
}

export type ContactDetailsPatch = {
  emails?: string[];
  phones?: string[];
  location?: string | null;
  links?: string[];
};

export class ContactDetailsError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A link as typed ("linkedin.com/in/x") or with its scheme; http(s) only. */
function cleanLink(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new ContactDetailsError(`“${value.slice(0, 60)}” isn’t a link.`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) {
    throw new ContactDetailsError(`“${value.slice(0, 60)}” isn’t a link.`);
  }
  return url.toString().replace(/\/$/, '').slice(0, 500);
}

/**
 * Edit the person's contact details from their profile. Each list given
 * replaces the stored one (the profile edits one value at a time and sends
 * the list back); an empty string removes that value.
 */
export async function updateContactDetails(ctx: SessionContext, contactId: string, patch: ContactDetailsPatch) {
  const data: { emails?: string[]; phones?: string[]; location?: string | null; links?: string[] } = {};
  const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];
  if (patch.emails) {
    const emails = dedupe(patch.emails.map((e) => e.trim().toLowerCase()));
    const bad = emails.find((e) => e.length > 254 || !EMAIL.test(e));
    if (bad) throw new ContactDetailsError(`“${bad.slice(0, 60)}” isn’t an email address.`);
    data.emails = emails.slice(0, 10);
  }
  if (patch.phones) {
    const phones = dedupe(patch.phones.map((p) => p.trim().replace(/\s+/g, ' ')));
    const bad = phones.find((p) => p.length > 40 || !/\d{3}/.test(p.replace(/\D/g, '')));
    if (bad) throw new ContactDetailsError(`“${bad.slice(0, 40)}” isn’t a phone number.`);
    data.phones = phones.slice(0, 10);
  }
  if (patch.location !== undefined) data.location = patch.location?.trim().slice(0, 120) || null;
  if (patch.links) data.links = dedupe(patch.links.map(cleanLink)).slice(0, 20);

  const fields = Object.keys(data);
  if (!fields.length) return;
  await db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { id: contactId, orgId: ctx.orgId }, select: { id: true } });
    if (!contact) throw new ContactDetailsError('Contact not found.');
    await tx.contact.update({ where: { id: contact.id }, data });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'contact.updated',
      subjectType: 'contact',
      subjectId: contact.id,
      // Which fields changed, never the values: contact details are personal data.
      payload: { fields },
    });
  });
  invalidateContactCounts(ctx.orgId);
}

/** Other contacts sharing an email, phone, or link with `contact` (already loaded and org-checked). */
export async function findDuplicates(
  orgId: string,
  contact: { id: string; emails: string[]; phones: string[]; links: string[] },
) {
  const or = [];
  if (contact.emails.length) or.push({ emails: { hasSome: contact.emails } });
  if (contact.phones.length) or.push({ phones: { hasSome: contact.phones } });
  if (contact.links.length) or.push({ links: { hasSome: contact.links } });
  if (!or.length) return [];
  return db.contact.findMany({
    where: { orgId, id: { not: contact.id }, OR: or },
    take: 5,
  });
}

/**
 * Merge `duplicateId` into `primaryId`: re-point opportunities, emails, and
 * consents; union the identity fields; keep the primary's resume unless it
 * has none. The duplicate row is deleted — the merge event records what
 * happened for the audit trail.
 */
export async function mergeContacts(ctx: SessionContext, primaryId: string, duplicateId: string) {
  if (primaryId === duplicateId) throw new Error('Cannot merge a contact into itself');
  const merged = await db.$transaction(async (tx) => {
    const [primary, duplicate] = await Promise.all([
      tx.contact.findFirst({ where: { id: primaryId, orgId: ctx.orgId } }),
      tx.contact.findFirst({ where: { id: duplicateId, orgId: ctx.orgId } }),
    ]);
    if (!primary || !duplicate) throw new Error('Contact not found');

    await tx.opportunity.updateMany({
      where: { contactId: duplicate.id },
      data: { contactId: primary.id },
    });
    await tx.emailMessage.updateMany({
      where: { contactId: duplicate.id },
      data: { contactId: primary.id },
    });
    await tx.consentRecord.updateMany({
      where: { contactId: duplicate.id },
      data: { contactId: primary.id },
    });
    // An import that brought in the duplicate should keep finding the person
    // (a ref to a missing contact reads as "erased" and is never re-imported).
    await tx.importRef.updateMany({
      where: { orgId: ctx.orgId, kind: 'contact', internalId: duplicate.id },
      data: { internalId: primary.id },
    });
    // Both resumes too: one stored before files had an owner would be orphaned
    // when the merge keeps the other, out of reach of anonymization.
    const resumeIds = [primary.resumeFileId, duplicate.resumeFileId].filter((id): id is string => !!id);
    await tx.storedFile.updateMany({
      where: { orgId: ctx.orgId, OR: [{ contactId: duplicate.id }, { id: { in: resumeIds }, contactId: null }] },
      data: { contactId: primary.id },
    });

    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    // File and text come as a pair, or the profile shows one resume and search
    // finds another. The primary's, unless it will never have text (a scan,
    // out of retries) and the duplicate's has: keep the readable one.
    let resume = primary.resumeFileId || !duplicate.resumeFileId ? primary : duplicate;
    if (resume === primary && primary.resumeFileId && !primary.resumeText && duplicate.resumeFileId && duplicate.resumeText) {
      const file = await tx.storedFile.findUnique({
        where: { id: primary.resumeFileId },
        select: { textStatus: true, textVersion: true, textAttempts: true },
      });
      if (!file || !textPending(file)) resume = duplicate;
    }
    const updated = await tx.contact.update({
      where: { id: primary.id },
      data: {
        emails: union(primary.emails, duplicate.emails),
        phones: union(primary.phones, duplicate.phones),
        links: union(primary.links, duplicate.links),
        tags: union(primary.tags, duplicate.tags),
        headline: primary.headline ?? duplicate.headline,
        location: primary.location ?? duplicate.location,
        resumeFileId: resume.resumeFileId,
        resumeText: resume.resumeFileId ? resume.resumeText : (primary.resumeText ?? duplicate.resumeText),
        // Unsubscribed or bounced as either: a merge never signs someone back up
        emailOptOutAt: primary.emailOptOutAt ?? duplicate.emailOptOutAt,
        emailBouncedAt: primary.emailBouncedAt ?? duplicate.emailBouncedAt,
      },
    });
    // Newsletter copies follow the person; where both got the same one, keep the primary's
    const primaryNewsletters = await tx.newsletterRecipient.findMany({ where: { contactId: primary.id }, select: { newsletterId: true } });
    await tx.newsletterRecipient.deleteMany({
      where: { contactId: duplicate.id, newsletterId: { in: primaryNewsletters.map((r) => r.newsletterId) } },
    });
    await tx.newsletterRecipient.updateMany({ where: { contactId: duplicate.id }, data: { contactId: primary.id } });
    await tx.contact.delete({ where: { id: duplicate.id } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'contact.merged',
      subjectType: 'contact',
      subjectId: primary.id,
      payload: { mergedName: duplicate.name, mergedId: duplicate.id },
    });
    return updated;
  });
  invalidateLists(ctx.orgId);
  return merged;
}

export type CsvImportResult = { created: number; skipped: number; errors: string[] };

/** Rows per round trip. Keeps each request far under Vercel's 4.5MB body cap. */
export const CSV_BATCH_ROWS = 1_000;

/**
 * CSV contact import. Expected header (order-free, case-insensitive):
 * name,email,phone,headline,location,tags — only name is required. Tags are
 * ;-separated inside the cell. Rows matching an existing contact email (or an
 * earlier row of the same file) are skipped, never overwritten.
 *
 * Imports one batch of already-parsed rows with a fixed number of queries —
 * one duplicate lookup, one insert, one event insert — regardless of batch
 * size. The browser parses the file and sends batches in order, which is
 * what lets a 50k-row file import with a progress bar and no request-size or
 * timeout ceiling. `firstRow` is the 1-based file line of rows[0], for errors.
 */
export async function importContactRows(
  ctx: SessionContext,
  header: string[],
  rows: string[][],
  firstRow: number,
): Promise<CsvImportResult> {
  const cols = header.map((h) => h.trim().toLowerCase());
  const col = (name: string) => cols.indexOf(name);
  if (col('name') === -1) return { created: 0, skipped: 0, errors: ['Missing required "name" column.'] };

  const result: CsvImportResult = { created: 0, skipped: 0, errors: [] };
  const parsed = rows.map((row, i) => {
    const cell = (name: string) => (col(name) >= 0 ? (row[col(name)] ?? '').trim() : '');
    return {
      line: firstRow + i,
      blank: !row.some((c) => c.trim()),
      name: cell('name'),
      email: cell('email').toLowerCase(),
      phone: cell('phone'),
      headline: cell('headline'),
      location: cell('location'),
      tags: cell('tags') ? cell('tags').split(';').map((t) => t.trim()).filter(Boolean) : [],
    };
  });

  const emails = [...new Set(parsed.map((r) => r.email).filter(Boolean))];
  const taken = new Set<string>();
  if (emails.length) {
    const existing = await db.contact.findMany({
      where: { orgId: ctx.orgId, emails: { hasSome: emails } },
      select: { emails: true },
    });
    for (const c of existing) for (const e of c.emails) taken.add(e.toLowerCase());
  }

  const contacts: {
    id: string;
    orgId: string;
    name: string;
    headline: string | null;
    location: string | null;
    emails: string[];
    phones: string[];
    tags: string[];
  }[] = [];
  for (const r of parsed) {
    if (!r.name) {
      if (!r.blank) result.errors.push(`Row ${r.line}: missing name.`);
      continue;
    }
    if (r.email && taken.has(r.email)) {
      result.skipped++;
      continue;
    }
    if (r.email) taken.add(r.email); // later rows in this file with the same email
    contacts.push({
      id: crypto.randomUUID(),
      orgId: ctx.orgId,
      name: capName(r.name),
      headline: r.headline || null,
      location: r.location || null,
      emails: r.email ? [r.email] : [],
      phones: r.phone ? [r.phone] : [],
      tags: r.tags,
    });
  }

  if (contacts.length) {
    const { actorType, actorId } = actorOf(ctx);
    await db.$transaction([
      db.contact.createMany({ data: contacts }),
      db.event.createMany({
        data: contacts.map((c) => ({
          orgId: ctx.orgId,
          actorType,
          actorId,
          verb: 'contact.created',
          subjectType: 'contact',
          subjectId: c.id,
          payload: { name: c.name, via: 'csv_import' },
        })),
      }),
    ]);
  }
  result.created = contacts.length;
  if (contacts.length) invalidateContactCounts(ctx.orgId);
  return result;
}

/** Whole-file import for server-side callers; batches internally. */
export async function importContactsCsv(ctx: SessionContext, csv: string): Promise<CsvImportResult> {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { created: 0, skipped: 0, errors: ['No data rows found.'] };
  const total: CsvImportResult = { created: 0, skipped: 0, errors: [] };
  for (let i = 1; i < rows.length; i += CSV_BATCH_ROWS) {
    const r = await importContactRows(ctx, rows[0], rows.slice(i, i + CSV_BATCH_ROWS), i + 1);
    total.created += r.created;
    total.skipped += r.skipped;
    total.errors.push(...r.errors);
    if (r.errors[0]?.startsWith('Missing required')) break;
  }
  return total;
}

export type SearchResults = {
  contacts: { id: string; name: string; headline: string | null; email: string | null; opportunityId: string | null; match: string }[];
  postings: { id: string; title: string; state: string }[];
  notes: { opportunityId: string; contactName: string; snippet: string }[];
  transcripts: { opportunityId: string; contactName: string; title: string; snippet: string }[];
  /** Which sections stopped at their limit with more matches left (never a silent cut). */
  more: { contacts: boolean; postings: boolean; notes: boolean; transcripts: boolean };
};

/** Results per section; each query asks for one more to know whether there are others. */
export const SEARCH_LIMITS = { people: 15, resumes: 10, postings: 10, notes: 10, transcripts: 10 } as const;

/**
 * Cross-record search: contact identity fields, resume text, note bodies,
 * and posting titles. Postgres ILIKE — instant at self-host scale; swap for
 * FTS/Meilisearch behind this same function when an org outgrows it.
 */
export async function searchAll(orgId: string, query: string): Promise<SearchResults> {
  const q = query.trim();
  const none = { contacts: false, postings: false, notes: false, transcripts: false };
  if (q.length < 2) return { contacts: [], postings: [], notes: [], transcripts: [], more: none };
  const L = SEARCH_LIMITS;

  const [byIdentityPlus, byResumePlus, postingsPlus, notesPlus, transcriptsPlus] = await Promise.all([
    db.contact.findMany({
      where: {
        orgId,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { headline: { contains: q, mode: 'insensitive' } },
          { emails: { hasSome: [q.toLowerCase()] } },
          { tags: { hasSome: [q.toLowerCase(), q] } },
        ],
      },
      include: { opportunities: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: L.people + 1,
    }),
    db.contact.findMany({
      where: { orgId, resumeText: { contains: q, mode: 'insensitive' } },
      include: { opportunities: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: L.resumes + 1,
    }),
    db.posting.findMany({
      where: { orgId, title: { contains: q, mode: 'insensitive' } },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: L.postings + 1,
    }),
    db.note.findMany({
      where: { orgId, body: { contains: q, mode: 'insensitive' } },
      include: { opportunity: { include: { contact: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: L.notes + 1,
    }),
    db.transcript.findMany({
      where: {
        orgId,
        OR: [
          { content: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: { opportunity: { include: { contact: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: L.transcripts + 1,
    }),
  ]);
  const byIdentity = byIdentityPlus.slice(0, L.people);
  const byResume = byResumePlus.slice(0, L.resumes);
  const postings = postingsPlus.slice(0, L.postings);
  const notes = notesPlus.slice(0, L.notes);
  const transcripts = transcriptsPlus.slice(0, L.transcripts);

  const seen = new Set<string>();
  const contacts: SearchResults['contacts'] = [];
  for (const [list, match] of [
    [byIdentity, 'profile'],
    [byResume, 'resume'],
  ] as const) {
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      contacts.push({
        id: c.id,
        name: c.name,
        headline: c.headline,
        email: c.emails[0] ?? null,
        opportunityId: c.opportunities[0]?.id ?? null,
        match,
      });
    }
  }

  return {
    contacts,
    more: {
      contacts: byIdentityPlus.length > L.people || byResumePlus.length > L.resumes,
      postings: postingsPlus.length > L.postings,
      notes: notesPlus.length > L.notes,
      transcripts: transcriptsPlus.length > L.transcripts,
    },
    postings: postings.map((p) => ({ id: p.id, title: p.title, state: p.state })),
    notes: notes.map((n) => ({
      opportunityId: n.opportunityId,
      contactName: n.opportunity.contact.name,
      snippet: snippetAround(n.body, q),
    })),
    transcripts: transcripts.map((t) => ({
      opportunityId: t.opportunityId,
      contactName: t.opportunity.contact.name,
      title: t.title,
      snippet: snippetAround(t.content, q),
    })),
  };
}

function snippetAround(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, idx + q.length + 60)}${idx + q.length + 60 < text.length ? '…' : ''}`;
}
