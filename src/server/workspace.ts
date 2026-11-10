import { db } from '@/lib/db';
import type { OrgKind } from '@prisma/client';
import { isSampleSlug } from '@/server/sample-boards';
import { DEFAULT_TEMPLATES } from '@/server/email';
import { DEFAULT_STAGES, DEFAULT_ARCHIVE_REASONS } from '@/server/org-defaults';

/**
 * Creating a workspace at sign-up: the organization with its default
 * pipeline, archive reasons and email templates, and its first user as super
 * admin. Password and Google sign-up both come through here, so a workspace
 * made either way starts out the same.
 */

export class EmailTakenError extends Error {
  constructor() {
    super('An account with this email already exists.');
    this.name = 'EmailTakenError';
  }
}

/** The one company this deployment serves. Demo and sample orgs don't count. */
export const SINGLE_COMPANY_MESSAGE =
  'This Orqestra workspace already has its company. Ask your admin to add you as a team member, or sign in.';

export async function companyExists(): Promise<boolean> {
  const count = await db.organization.count({
    where: {
      NOT: {
        OR: [
          { slug: { startsWith: 'demo' } },
          { slug: { startsWith: 'sample-' } },
        ],
      },
    },
  });
  return count > 0;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

export type NewWorkspace = {
  orgName: string;
  name: string;
  email: string;
  /** null for someone who signs in with Google only. */
  passwordHash: string | null;
  /** The Google account to bind, when signing up with Google. */
  googleSub?: string | null;
  /** Company (the default) or staffing agency, e.g. from /agencies' Get started. */
  kind?: OrgKind;
};

export async function createWorkspace(input: NewWorkspace): Promise<{ orgId: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const orgName = input.orgName.trim();
  const name = input.name.trim();

  const baseSlug = slugify(orgName) || 'org';
  // `sample-` slugs belong to the homepage's sample boards (server/sample-boards.ts).
  const slugTaken =
    isSampleSlug(baseSlug) || (await db.organization.findUnique({ where: { slug: baseSlug } }));
  const slug = slugTaken ? `${baseSlug}-${Math.random().toString(36).slice(2, 7)}` : baseSlug;

  return db.$transaction(async (tx) => {
    // One sign-up per address at a time, so a double submit can't make two
    // workspaces; then refuse an address that already has an account.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signup:${email}`}))`;
    // lower() =, not Prisma's `mode: 'insensitive'`: that's an unescaped
    // ILIKE, where "_" in an address matches any character.
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User" WHERE lower(email) = ${email} LIMIT 1`;
    if (existing.length) throw new EmailTakenError();

    const org = await tx.organization.create({ data: { name: orgName, slug, kind: input.kind ?? 'COMPANY' } });
    const user = await tx.user.create({
      data: {
        orgId: org.id,
        email,
        name,
        passwordHash: input.passwordHash,
        googleSub: input.googleSub ?? null,
        accessRole: 'SUPER_ADMIN',
      },
    });
    await tx.stage.createMany({
      data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: org.id })),
    });
    await tx.archiveReason.createMany({
      data: DEFAULT_ARCHIVE_REASONS.map((r) => ({ ...r, orgId: org.id })),
    });
    const [confirmTpl, , interviewTpl] = await Promise.all(
      DEFAULT_TEMPLATES.map((t) => tx.emailTemplate.create({ data: { ...t, orgId: org.id } })),
    );
    await tx.organization.update({
      where: { id: org.id },
      data: {
        autoConfirmTemplateId: confirmTpl.id, // rejection automation stays opt-in
        autoInterviewTemplateId: interviewTpl.id,
      },
    });
    await tx.event.create({
      data: {
        orgId: org.id,
        actorType: 'user',
        actorId: user.id,
        verb: 'org.created',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name: orgName, slug },
      },
    });
    return { orgId: org.id, userId: user.id };
  });
}
