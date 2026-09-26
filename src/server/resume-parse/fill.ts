import type { Prisma } from '@prisma/client';
import { emitEvent } from '@/server/events';
import { isProfileLink, uniqueLinks } from '@/server/resume';
import { appearsAsWords, comparable, looksLikeContactDetail, type ResumeProfile } from './validate';

/**
 * What a parsed resume may change on the contact: only fields that are
 * empty, and only with values the resume itself shows.
 *
 *   - headline, location: when blank, and only a value found in the resume
 *     text as whole words (a current "{title} at {company}" when the model's
 *     headline isn't there), and never a phone number, address or link.
 *   - phones: when the contact has none; at most 3, each one in the text.
 *   - links: when the contact has none; profile links only (linkedin.com/in,
 *     github.com/…), each one written out in the text. A company's site, or
 *     another person's profile on a host the resume mentions, would make
 *     unrelated candidates look like duplicates of each other.
 *
 * Never written: name, emails, tags, the resume text, anything on an
 * opportunity, or any other contact. Emails in particular: they are how an
 * application finds its contact, and a resume lists other people's
 * (references, managers), so an address from one could route a stranger's
 * application onto this contact. Parsed emails stay in StoredFile.parsed.
 *
 * A human edit always wins: the write is conditional on the contact's
 * updatedAt, and a changed contact is re-read (once) before trying again.
 */

type Tx = Prisma.TransactionClient;

export type FillField = 'headline' | 'location';

export type FillResult = {
  filled: FillField[];
  added: { phones: number; links: number };
  /** What was written, for StoredFile.parsed.filled (the file is erased with the candidate). */
  values: { headline?: string; location?: string; phones?: string[]; links?: string[] };
};

const HEADLINE_MAX = 200;
const LOCATION_MAX = 120;
const MAX_PHONES = 3;
const MAX_LINKS = 10;

const blank = (v: string | null | undefined) => !v || !v.trim();

const SHOWN_URL = /https?:\/\/[^\s)>\]"'<]+|(?<![\w@./-])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s)>\]"'<]+/gi;

/** Scheme, "www." and a trailing slash or punctuation don't make two links different. */
function urlKey(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[.,;:!?'"]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Every URL the resume text shows, written with or without a scheme. */
export function urlsShown(text: string): Set<string> {
  return new Set((text.match(SHOWN_URL) ?? []).map(urlKey));
}

/** Whether `value` is in the text as whole words, ignoring case and spacing. */
const appears = appearsAsWords;

/** A value the resume shows that reads as a headline or a place, not a contact detail. */
const fits = (value: string, text: string) => appears(value, text) && !looksLikeContactDetail(value);

export function planFill(
  contact: { headline: string | null; location: string | null; phones: string[]; links: string[] },
  profile: ResumeProfile,
  sourceText: string,
): { data: Prisma.ContactUpdateManyMutationInput; result: FillResult } {
  const text = comparable(sourceText);
  const data: Prisma.ContactUpdateManyMutationInput = {};
  const result: FillResult = { filled: [], added: { phones: 0, links: 0 }, values: {} };

  if (blank(contact.headline)) {
    let headline: string | null = null;
    if (profile.headline && fits(profile.headline, text)) headline = profile.headline;
    else {
      const current = profile.experience.find((e) => e.end === 'present' && e.title && e.company);
      if (current && fits(current.title!, text) && fits(current.company!, text)) headline = `${current.title} at ${current.company}`;
    }
    if (headline) {
      data.headline = headline.slice(0, HEADLINE_MAX).trim();
      result.filled.push('headline');
      result.values.headline = data.headline;
    }
  }

  if (blank(contact.location) && profile.location && fits(profile.location, text)) {
    data.location = profile.location.slice(0, LOCATION_MAX).trim();
    result.filled.push('location');
    result.values.location = data.location;
  }

  if (!contact.phones.length && profile.phones.length) {
    // validate.ts already required each one as the text writes it, and isPhone.
    const phones = profile.phones.slice(0, MAX_PHONES);
    data.phones = phones;
    result.added.phones = phones.length;
    result.values.phones = phones;
  }

  if (!contact.links.length && profile.links.length) {
    const shown = urlsShown(sourceText);
    const links = uniqueLinks(
      profile.links.filter((l) => isProfileLink(l) && shown.has(urlKey(l))),
      MAX_LINKS,
    );
    if (links.length) {
      data.links = links;
      result.added.links = links.length;
      result.values.links = links;
    }
  }

  return { data, result };
}

export const filledAnything = (r: FillResult) => r.filled.length > 0 || r.added.phones > 0 || r.added.links > 0;

/**
 * Fill the contact's empty fields from `profile`, inside the caller's
 * transaction. Returns null when the contact is no longer this resume's
 * (a newer application replaced it, a merge, an erasure), else what changed.
 */
export async function fillContactFromResume(
  tx: Tx,
  input: {
    orgId: string;
    contactId: string;
    fileId: string;
    profile: ResumeProfile;
    sourceText: string;
    model: string;
    providerLabel: string;
  },
): Promise<FillResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const contact = await tx.contact.findFirst({
      where: { id: input.contactId, orgId: input.orgId },
      select: { id: true, resumeFileId: true, isAnonymized: true, headline: true, location: true, phones: true, links: true, updatedAt: true },
    });
    if (!contact || contact.isAnonymized || contact.resumeFileId !== input.fileId) return null;

    const { data, result } = planFill(contact, input.profile, input.sourceText);
    if (!filledAnything(result)) return result;

    // Only if nobody changed the contact since it was read.
    const wrote = await tx.contact.updateMany({
      where: { id: contact.id, orgId: input.orgId, updatedAt: contact.updatedAt, resumeFileId: input.fileId, isAnonymized: false },
      data,
    });
    if (!wrote.count) continue;

    // Names and counts only, never values: webhooks with no filter receive every event.
    await emitEvent(tx, {
      orgId: input.orgId,
      actorType: 'system',
      verb: 'contact.resume_parsed',
      subjectType: 'contact',
      subjectId: contact.id,
      payload: {
        fileId: input.fileId,
        model: input.model,
        provider: input.providerLabel,
        filled: result.filled,
        added: result.added,
      },
    });
    return result;
  }
  return null;
}
