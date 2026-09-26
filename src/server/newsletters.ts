import nodemailer from 'nodemailer';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { readBrand } from '@/lib/brand';
import type { SessionContext } from '@/lib/session';
import { renderTemplate } from '@/server/email';
import {
  renderNewsletterHtml,
  renderNewsletterText,
  unsubscribeToken,
  type NewsletterContent,
} from '@/server/newsletter-email';

/**
 * Newsletters: one email about open roles to every candidate.
 *
 * Who gets it: every contact who has been in a pipeline (applied, or was
 * added to a role) and has an email address, except anyone who
 * unsubscribed, whose address bounced or who marked one as spam, who was
 * anonymized, or who declined to have their profile kept.
 *
 * Sending: starting a send makes one NewsletterRecipient per person (unique
 * per newsletter, so a retry can't email anyone twice), sends the first
 * batch at once, and /api/cron/newsletters sends the rest, chaining its
 * next run right away while copies are left.
 * Batches are claimed with FOR UPDATE SKIP LOCKED, so two runs never take
 * the same rows. Each copy carries a signed unsubscribe link and RFC 8058
 * one-click unsubscribe headers. Delivery goes through SMTP_URL like every
 * other email; without it, a production server won't start a send (nothing
 * would leave it), and development marks copies sent.
 */

export class NewsletterError extends Error {}

const BATCH = 25;
/** A claimed copy not finished in this long was interrupted mid-send: failed, never resent. */
const STALE_CLAIM_MS = 15 * 60_000;

export const deliveryConfigured = () => !!process.env.SMTP_URL;
export const canSendNewsletters = () => deliveryConfigured() || process.env.NODE_ENV !== 'production';

/** The contacts a newsletter goes to. */
export function audienceWhere(orgId: string): Prisma.ContactWhereInput {
  return {
    orgId,
    isAnonymized: false,
    emails: { isEmpty: false },
    emailOptOutAt: null,
    emailBouncedAt: null,
    opportunities: { some: {} },
    // declined to have their profile kept: no job emails either
    NOT: {
      consents: { some: { purpose: 'PROFILE_STORAGE' } },
      AND: { NOT: { consents: { some: { purpose: 'PROFILE_STORAGE', withdrawnAt: null } } } },
    },
  };
}

export const countAudience = (orgId: string) => db.contact.count({ where: audienceWhere(orgId) });

export type NewsletterInput = { subject: string; body: string; postingIds: string[] };

function clean(input: NewsletterInput): NewsletterInput {
  const subject = input.subject.trim().slice(0, 200);
  const body = input.body.trim().slice(0, 20_000);
  if (!subject) throw new NewsletterError('Add a subject.');
  if (!body) throw new NewsletterError('Write the message.');
  return { subject, body, postingIds: [...new Set(input.postingIds)].slice(0, 12) };
}

async function ownPostings(orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const found = await db.posting.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } });
  const ok = new Set(found.map((p) => p.id));
  return ids.filter((id) => ok.has(id));
}

export async function saveNewsletter(ctx: SessionContext, id: string | null, raw: NewsletterInput) {
  const input = clean(raw);
  const postingIds = await ownPostings(ctx.orgId, input.postingIds);
  if (!id) {
    return db.newsletter.create({ data: { orgId: ctx.orgId, createdById: ctx.userId, ...input, postingIds } });
  }
  const existing = await db.newsletter.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!existing) throw new NewsletterError('Newsletter not found.');
  if (existing.status !== 'DRAFT') throw new NewsletterError('This newsletter has already been sent.');
  return db.newsletter.update({ where: { id }, data: { ...input, postingIds } });
}

export async function deleteNewsletter(ctx: SessionContext, id: string) {
  const { count } = await db.newsletter.deleteMany({ where: { id, orgId: ctx.orgId, status: 'DRAFT' } });
  if (!count) throw new NewsletterError('Only drafts can be deleted.');
}

// ---------- rendering one copy ----------

type Sendable = Awaited<ReturnType<typeof loadSendable>>;

async function loadSendable(newsletterId: string) {
  const n = await db.newsletter.findUnique({
    where: { id: newsletterId },
    include: { org: { select: { name: true, slug: true, logoFileId: true, brand: true } } },
  });
  if (!n) return null;
  const postings = await db.posting.findMany({
    where: { orgId: n.orgId, id: { in: n.postingIds }, state: 'PUBLISHED' },
    select: { id: true, slug: true, title: true, location: true, workplaceType: true, commitment: true },
  });
  const byId = new Map(postings.map((p) => [p.id, p]));
  return { ...n, roles: n.postingIds.map((id) => byId.get(id)).filter((p) => !!p) };
}

/** The merge tokens a newsletter can use: {{first_name}} and {{company_name}}. */
export const NEWSLETTER_TOKENS = ['first_name', 'company_name'] as const;
const varsFor = (name: string, orgName: string) => ({ first_name: name.trim().split(/\s+/)[0] ?? '', company_name: orgName });

/**
 * Its content for one reader (`name` fills {{first_name}}); `contactId`
 * null is a test copy or a preview, whose unsubscribe link does nothing.
 */
export function contentFor(n: NonNullable<Sendable>, baseUrl: string, contactId: string | null, name: string): NewsletterContent {
  const board = `${baseUrl}/careers/${n.org.slug}`;
  const vars = varsFor(name, n.org.name);
  return {
    orgName: n.org.name,
    subject: renderTemplate(n.subject, vars),
    body: renderTemplate(n.body, vars),
    roles: n.roles.map((p) => ({ title: p.title, location: p.location, workplaceType: p.workplaceType, commitment: p.commitment, url: `${board}/${p.slug}` })),
    boardUrl: board,
    unsubscribeUrl: contactId ? `${baseUrl}/unsubscribe/${unsubscribeToken(contactId)}` : `${baseUrl}/unsubscribe/preview`,
    logoUrl: n.org.logoFileId ? `${baseUrl}/api/logo/${n.org.logoFileId}` : null,
    brand: readBrand(n.org.brand),
  };
}

/** EMAIL_FROM's address, shown as the organization. */
function fromFor(orgName: string): string {
  const configured = process.env.EMAIL_FROM ?? 'Source <no-reply@source.local>';
  const address = configured.match(/<([^>]+)>/)?.[1] ?? configured.trim();
  return `"${orgName.replace(/["\\\r\n]/g, '').slice(0, 80)}" <${address}>`;
}

type Transport = ReturnType<typeof nodemailer.createTransport> | null;

async function deliverCopy(transport: Transport, n: NonNullable<Sendable>, baseUrl: string, to: string, contactId: string | null, name: string) {
  const content = contentFor(n, baseUrl, contactId, name);
  if (!transport) return; // development without SMTP: recorded as sent
  await transport.sendMail({
    from: fromFor(n.org.name),
    to,
    subject: content.subject,
    text: renderNewsletterText(content),
    html: renderNewsletterHtml(content),
    headers: contactId
      ? {
          // RFC 8058 one-click: mail clients POST here, no page in between
          'List-Unsubscribe': `<${baseUrl}/api/unsubscribe/${unsubscribeToken(contactId)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
  });
}

const transportOrNull = (): Transport => (process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null);

/** A copy to the sender, to see it in a real inbox before everyone does. */
export async function sendTestNewsletter(ctx: SessionContext, id: string, baseUrl: string) {
  const n = await loadSendable(id);
  if (!n || n.orgId !== ctx.orgId) throw new NewsletterError('Newsletter not found.');
  const me = await db.user.findUnique({ where: { id: ctx.userId ?? '' }, select: { email: true, name: true } });
  if (!me?.email) throw new NewsletterError('Your account has no email address.');
  if (!canSendNewsletters()) throw new NewsletterError('Email delivery isn’t set up on this server yet.');
  await deliverCopy(transportOrNull(), n, baseUrl, me.email, null, me.name ?? '');
  return me.email;
}

/** The email as a reader would see it, from unsaved input: for the editor's preview. */
export async function previewNewsletter(ctx: SessionContext, input: NewsletterInput, baseUrl: string): Promise<string> {
  const org = await db.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true, slug: true, logoFileId: true, brand: true } });
  if (!org) throw new NewsletterError('Organization not found.');
  const ids = input.postingIds.slice(0, 12);
  const postings = await db.posting.findMany({
    where: { orgId: ctx.orgId, id: { in: ids }, state: 'PUBLISHED' },
    select: { id: true, slug: true, title: true, location: true, workplaceType: true, commitment: true },
  });
  const byId = new Map(postings.map((p) => [p.id, p]));
  const n = {
    org,
    subject: input.subject.slice(0, 200),
    body: input.body.slice(0, 20_000),
    roles: ids.map((id) => byId.get(id)).filter((p) => !!p),
  } as unknown as NonNullable<Sendable>;
  return renderNewsletterHtml(contentFor(n, baseUrl, null, 'Alex'));
}

// ---------- sending to everyone ----------

/** Freeze the audience and start sending. Returns how many it's going to. */
export async function startNewsletter(ctx: SessionContext, id: string, baseUrl: string): Promise<number> {
  if (!canSendNewsletters()) throw new NewsletterError('Email delivery isn’t set up on this server yet.');
  const n = await db.newsletter.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!n) throw new NewsletterError('Newsletter not found.');
  // Claim the draft: only one start can move it out of DRAFT
  const claimed = await db.newsletter.updateMany({
    where: { id, status: 'DRAFT' },
    data: { status: 'SENDING', sendStartedAt: new Date(), sentById: ctx.userId, baseUrl },
  });
  if (!claimed.count) throw new NewsletterError('This newsletter has already been sent.');

  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await db.contact.findMany({
      where: audienceWhere(ctx.orgId),
      select: { id: true, emails: true },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    const { count } = await db.newsletterRecipient.createMany({
      data: page.map((c) => ({ newsletterId: id, orgId: ctx.orgId, contactId: c.id, email: c.emails[0] })),
      skipDuplicates: true,
    });
    total += count;
    cursor = page[page.length - 1].id;
  }

  await db.$transaction(async (tx) => {
    await tx.newsletter.update({ where: { id }, data: { recipientCount: total } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'newsletter.sent',
      subjectType: 'newsletter',
      subjectId: id,
      payload: { subject: n.subject, recipients: total },
    });
  });
  return total;
}

/** Claim up to BATCH unsent copies of one newsletter; no other run can take them. */
async function claim(newsletterId: string) {
  return db.$queryRaw<{ id: string; contactId: string; email: string }[]>`
    UPDATE "NewsletterRecipient" SET status = 'SENDING', "claimedAt" = now()
    WHERE id IN (
      SELECT id FROM "NewsletterRecipient"
      WHERE "newsletterId" = ${newsletterId} AND status = 'PENDING'
      ORDER BY id
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "contactId", email`;
}

/**
 * Send what's due for up to `budgetMs` (/api/cron/newsletters, which chains
 * itself while `more` is true). Returns the copies sent.
 */
export async function processNewsletters(budgetMs = 40_000): Promise<{ sent: number; more: boolean }> {
  const until = Date.now() + budgetMs;
  // interrupted mid-send: failed, never sent twice
  await db.newsletterRecipient.updateMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { status: 'FAILED', error: 'interrupted' },
  });

  const sending = await db.newsletter.findMany({ where: { status: 'SENDING' }, select: { id: true }, orderBy: { sendStartedAt: 'asc' } });
  const transport = transportOrNull();
  let sent = 0;
  for (const { id } of sending) {
    const n = await loadSendable(id);
    if (!n) continue;
    const baseUrl = n.baseUrl ?? '';
    while (Date.now() < until) {
      const batch = await claim(id);
      if (!batch.length) break;
      // Re-check each person: they may have unsubscribed or bounced since the send started
      const eligible = new Map(
        (
          await db.contact.findMany({
            where: { ...audienceWhere(n.orgId), id: { in: batch.map((r) => r.contactId) } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      for (const r of batch) {
        const name = eligible.get(r.contactId);
        if (name === undefined) {
          await db.newsletterRecipient.update({ where: { id: r.id }, data: { status: 'SKIPPED' } });
          continue;
        }
        try {
          await deliverCopy(transport, n, baseUrl, r.email, r.contactId, name);
          await db.newsletterRecipient.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: new Date() } });
          sent++;
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 300) : 'send failed';
          await db.newsletterRecipient.update({ where: { id: r.id }, data: { status: 'FAILED', error: message } });
        }
      }
    }
    await finishIfDone(id);
    if (Date.now() >= until) break;
  }
  const more = (await db.newsletterRecipient.count({ where: { status: 'PENDING' }, take: 1 })) > 0;
  return { sent, more };
}

/** Counts, and SENT once nothing is left to send. */
async function finishIfDone(id: string) {
  const counts = await db.newsletterRecipient.groupBy({ by: ['status'], where: { newsletterId: id }, _count: true });
  const of = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const open = of('PENDING') + of('SENDING');
  await db.newsletter.update({
    where: { id },
    data: { sentCount: of('SENT'), failedCount: of('FAILED'), ...(open ? {} : { status: 'SENT', sentAt: new Date() }) },
  });
}

// ---------- unsubscribing and bounces ----------

/** Take one contact off every future newsletter. Idempotent. */
export async function unsubscribeContact(contactId: string, via: 'link' | 'one_click') {
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true, orgId: true, emailOptOutAt: true } });
  if (!contact) return null;
  if (!contact.emailOptOutAt) {
    await db.$transaction(async (tx) => {
      await tx.contact.update({ where: { id: contact.id }, data: { emailOptOutAt: new Date() } });
      await emitEvent(tx, {
        orgId: contact.orgId,
        actorType: 'system',
        verb: 'contact.unsubscribed',
        subjectType: 'contact',
        subjectId: contact.id,
        payload: { via },
      });
    });
  }
  return db.organization.findUnique({ where: { id: contact.orgId }, select: { name: true } });
}

/** An address that hard-bounced or complained: off every future newsletter, in every organization. */
export async function suppressAddress(email: string, reason: 'bounce' | 'complaint') {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return 0;
  const contacts = await db.contact.findMany({
    where: { emails: { hasSome: [...new Set([address, email.trim()])] }, emailBouncedAt: null },
    select: { id: true, orgId: true },
  });
  for (const c of contacts) {
    await db.$transaction(async (tx) => {
      await tx.contact.update({ where: { id: c.id }, data: { emailBouncedAt: new Date() } });
      await emitEvent(tx, { orgId: c.orgId, actorType: 'system', verb: 'contact.email_suppressed', subjectType: 'contact', subjectId: c.id, payload: { reason } });
    });
  }
  return contacts.length;
}
