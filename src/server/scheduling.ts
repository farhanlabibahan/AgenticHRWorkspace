import { randomBytes } from 'crypto';
import type { StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { sendEmail } from '@/server/email';
import { sendInterviewConfirmation } from '@/server/interviews';
import type { SessionContext } from '@/lib/session';

/**
 * Candidate self-scheduling. A recruiter mints a single-use booking link for
 * one opportunity; the candidate picks any open slot inside the availability
 * window and the booking itself creates the Interview. Slots are computed
 * fresh on every request — panelists' existing SCHEDULED interviews block
 * overlapping times, so a slot that was open when the page rendered is
 * re-validated at booking time inside the transaction.
 */

const SLOT_STEP_MINS = 30;
const MIN_NOTICE_MS = 60 * 60 * 1000; // candidates can't book inside the next hour

export type ScheduleSlot = { startAt: Date };

// ---------- timezone math (no deps) ----------

/** Offset of `tz` from UTC at the given instant, in ms. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/** UTC instant for a wall-clock time in `tz` (two-pass to settle DST edges). */
function fromZoned(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m, d, h, min);
  const off1 = tzOffsetMs(tz, new Date(guess));
  const off2 = tzOffsetMs(tz, new Date(guess - off1));
  return new Date(guess - off2);
}

/** Calendar date + weekday of an instant as seen in `tz`. */
function zonedDate(at: Date, tz: string): { y: number; m: number; d: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day), weekday };
}

// ---------- recruiter side ----------

export type CreateSchedulingLinkInput = {
  opportunityId: string;
  title: string;
  durationMins: number;
  location?: string;
  focusAreas?: string[];
  panelistIds: string[];
  windowDays?: number;
  dayStartHour?: number;
  dayEndHour?: number;
  timezone?: string;
};

export async function createSchedulingLink(ctx: SessionContext, input: CreateSchedulingLinkInput) {
  const opportunity = await db.opportunity.findFirst({
    where: { id: input.opportunityId, orgId: ctx.orgId },
    include: { contact: true },
  });
  if (!opportunity) throw new Error('Opportunity not found');
  const panelists = await db.user.findMany({
    where: { id: { in: input.panelistIds }, orgId: ctx.orgId },
  });
  if (!panelists.length) throw new Error('Pick at least one panelist');

  const dayStartHour = Math.min(Math.max(input.dayStartHour ?? 9, 0), 23);
  const dayEndHour = Math.min(Math.max(input.dayEndHour ?? 17, dayStartHour + 1), 24);
  const timezone = input.timezone ?? 'America/New_York';
  // Reject bogus zones up front instead of 500ing the public page later.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('Unknown timezone');
  }

  return db.$transaction(async (tx) => {
    const link = await tx.schedulingLink.create({
      data: {
        orgId: ctx.orgId,
        opportunityId: opportunity.id,
        token: randomBytes(24).toString('base64url'),
        title: input.title,
        durationMins: input.durationMins,
        location: input.location || null,
        focusAreas: input.focusAreas ?? [],
        windowDays: Math.min(Math.max(input.windowDays ?? 14, 1), 60),
        dayStartHour,
        dayEndHour,
        timezone,
        createdById: ctx.userId,
        panelists: { connect: panelists.map((p) => ({ id: p.id })) },
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'scheduling.link_created',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { contactName: opportunity.contact.name, title: input.title },
    });
    return link;
  });
}

export async function revokeSchedulingLink(ctx: SessionContext, linkId: string) {
  await db.schedulingLink.deleteMany({
    where: { id: linkId, orgId: ctx.orgId, usedAt: null },
  });
}

export function listSchedulingLinks(ctx: SessionContext, opportunityId: string) {
  return db.schedulingLink.findMany({
    where: { orgId: ctx.orgId, opportunityId, usedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { panelists: { select: { name: true } } },
  });
}

/**
 * On Screen / On-site stage entry, mint (or reuse) a booking link and email
 * it to the candidate. No-ops when the org toggle is off, the candidate has
 * no email, or there's nobody to sit on the panel.
 */
export async function maybeAutoSendSchedulingLink(
  ctx: SessionContext,
  opportunityId: string,
  stage: { name: string; type: StageType },
  baseUrl: string,
) {
  if (stage.type !== 'SCREEN' && stage.type !== 'ONSITE') return null;

  const org = await db.organization.findUnique({
    where: { id: ctx.orgId },
    select: { autoScheduleOnInterviewStages: true, name: true },
  });
  if (!org?.autoScheduleOnInterviewStages) return null;

  const opportunity = await db.opportunity.findFirst({
    where: { id: opportunityId, orgId: ctx.orgId },
    include: {
      contact: true,
      posting: { include: { planSteps: { orderBy: { order: 'asc' } } } },
      schedulingLinks: { where: { usedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!opportunity) return null;
  const toEmail = opportunity.contact.emails[0];
  if (!toEmail) return null;

  let link = opportunity.schedulingLinks[0];
  if (!link) {
    const panelistId = opportunity.ownerId ?? ctx.userId;
    if (!panelistId) return null;
    const step =
      stage.type === 'ONSITE'
        ? opportunity.posting?.planSteps[1] ?? opportunity.posting?.planSteps[0]
        : opportunity.posting?.planSteps[0];
    link = await createSchedulingLink(ctx, {
      opportunityId,
      title: step?.title ?? `${stage.name} interview`,
      durationMins: step?.durationMins ?? 45,
      focusAreas: step?.focusAreas,
      panelistIds: [panelistId],
    });
  }

  const first = opportunity.contact.name.split(' ')[0] || opportunity.contact.name;
  await sendEmail({
    orgId: ctx.orgId,
    actorId: ctx.userId ?? undefined,
    contactId: opportunity.contactId,
    opportunityId,
    toEmail,
    subject: `Pick a time for your ${link.title} with ${org.name}`,
    body: [
      `Hi ${first},`,
      '',
      `Please pick a time for your ${link.title} with ${org.name}:`,
      '',
      `${baseUrl}/schedule/${link.token}`,
      '',
      `Times are shown in your local timezone. If none of the slots work, reply to this email and we'll find another time.`,
    ].join('\n'),
  });
  return link;
}

// ---------- candidate side ----------

export function getSchedulingLink(token: string) {
  return db.schedulingLink.findUnique({
    where: { token },
    include: {
      org: { select: { name: true, logoFileId: true } },
      opportunity: { include: { contact: { select: { name: true } }, posting: { select: { title: true } } } },
      panelists: { select: { id: true, name: true } },
      interview: { select: { startAt: true, durationMins: true } },
    },
  });
}

type LinkForSlots = {
  createdAt: Date;
  windowDays: number;
  dayStartHour: number;
  dayEndHour: number;
  durationMins: number;
  timezone: string;
  panelists: { id: string }[];
};

/**
 * All open slots for a link: weekday wall-clock hours in the link's timezone,
 * on a 30-minute grid, minus anything overlapping a panelist's existing
 * scheduled interview.
 */
export async function listOpenSlots(link: LinkForSlots): Promise<ScheduleSlot[]> {
  const now = Date.now();
  const notBefore = now + MIN_NOTICE_MS;
  const horizon = link.createdAt.getTime() + link.windowDays * 24 * 60 * 60 * 1000;
  if (horizon <= notBefore) return [];

  const busy = await db.interview.findMany({
    where: {
      state: 'SCHEDULED',
      startAt: { gte: new Date(now - 24 * 60 * 60 * 1000), lte: new Date(horizon + 24 * 60 * 60 * 1000) },
      panelists: { some: { id: { in: link.panelists.map((p) => p.id) } } },
    },
    select: { startAt: true, durationMins: true },
  });
  const blocks = busy.map((b) => ({
    start: b.startAt.getTime(),
    end: b.startAt.getTime() + b.durationMins * 60 * 1000,
  }));

  const slots: ScheduleSlot[] = [];
  const durMs = link.durationMins * 60 * 1000;
  for (let dayMs = now; dayMs <= horizon; dayMs += 24 * 60 * 60 * 1000) {
    const { y, m, d, weekday } = zonedDate(new Date(dayMs), link.timezone);
    if (weekday === 0 || weekday === 6) continue; // weekends off in v1
    for (
      let mins = link.dayStartHour * 60;
      mins + link.durationMins <= link.dayEndHour * 60;
      mins += SLOT_STEP_MINS
    ) {
      const start = fromZoned(y, m, d, Math.floor(mins / 60), mins % 60, link.timezone);
      const t = start.getTime();
      if (t < notBefore || t > horizon) continue;
      if (blocks.some((b) => t < b.end && t + durMs > b.start)) continue;
      slots.push({ startAt: start });
    }
  }
  slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return slots;
}

/**
 * Book a slot. Re-validates everything inside the transaction: link unused,
 * slot still on the open grid, no new panelist conflict. Creates the
 * Interview, marks the link used, and emails the candidate a confirmation.
 */
export async function bookSchedulingSlot(token: string, startAtIso: string) {
  const startAt = new Date(startAtIso);
  if (Number.isNaN(startAt.getTime())) throw new Error('Invalid time');

  const booked = await db.$transaction(async (tx) => {
    const link = await tx.schedulingLink.findUnique({
      where: { token },
      include: { panelists: { select: { id: true } }, opportunity: { include: { contact: true } } },
    });
    if (!link || link.usedAt) throw new Error('This scheduling link is no longer active');

    const open = await listOpenSlots(link);
    if (!open.some((s) => s.startAt.getTime() === startAt.getTime()))
      throw new Error('That time was just taken — pick another slot');

    const interview = await tx.interview.create({
      data: {
        orgId: link.orgId,
        opportunityId: link.opportunityId,
        title: link.title,
        startAt,
        durationMins: link.durationMins,
        location: link.location,
        focusAreas: link.focusAreas,
        panelists: { connect: link.panelists.map((p) => ({ id: p.id })) },
      },
    });
    await tx.schedulingLink.update({
      where: { id: link.id },
      data: { usedAt: new Date(), interviewId: interview.id },
    });
    await emitEvent(tx, {
      orgId: link.orgId,
      actorType: 'candidate',
      actorId: link.opportunity.contactId,
      verb: 'interview.self_scheduled',
      subjectType: 'opportunity',
      subjectId: link.opportunityId,
      payload: {
        contactName: link.opportunity.contact.name,
        title: link.title,
        startAt: startAt.toISOString(),
      },
    });
    return { interview, link };
  });

  await sendInterviewConfirmation({
    orgId: booked.link.orgId,
    actorId: null,
    interviewId: booked.interview.id,
    opportunityId: booked.link.opportunityId,
    title: booked.link.title,
    startAt,
    durationMins: booked.link.durationMins,
    location: booked.link.location ?? undefined,
  });

  return booked.interview;
}
