import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { DEFAULT_STAGES, DEFAULT_ARCHIVE_REASONS } from '@/server/org-defaults';

/**
 * Clean demo workspace: one organization with a manager/recruiter (admin) and
 * an employee. Stages and leave types exist so every screen works; no
 * candidates, attendance or leave requests are created, so testing starts from
 * an empty state. Passwords are rotated on every demo sign-in, so no static
 * credential exists.
 */

export const DEMO_ORG_SLUG = 'demo-workspace';
export const DEMO_ACCOUNTS = {
  manager: { email: 'manager@source.demo', name: 'Demo Manager', accessRole: 'ADMIN' as const },
  employee: { email: 'employee@source.demo', name: 'Demo Employee', accessRole: 'TEAM_MEMBER' as const },
};

export type DemoRole = keyof typeof DEMO_ACCOUNTS;

export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === '1' || process.env.NODE_ENV === 'development';
}

export async function ensureDemoAccount(role: DemoRole): Promise<{ email: string; password: string }> {
  const account = DEMO_ACCOUNTS[role];
  const password = randomBytes(24).toString('base64url');
  // Cost 4 is fine: the password is 192 random bits and rotated on every login.
  const passwordHash = await bcrypt.hash(password, 4);

  let org = await db.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  if (!org) {
    org = await db.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: { name: 'Demo Company', slug: DEMO_ORG_SLUG, onboardedAt: new Date() },
      });
      await tx.stage.createMany({ data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: created.id })) });
      await tx.archiveReason.createMany({
        data: DEFAULT_ARCHIVE_REASONS.map((r) => ({ ...r, orgId: created.id })),
      });
      await tx.leaveType.createMany({
        data: [
          { orgId: created.id, name: 'Annual', annualDays: 20, paid: true },
          { orgId: created.id, name: 'Sick', annualDays: 10, paid: true },
          { orgId: created.id, name: 'Unpaid', annualDays: 0, paid: false },
        ],
      });
      return created;
    });
  }

  const existing = await db.user.findFirst({ where: { orgId: org.id, email: account.email } });
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { passwordHash, deactivatedAt: null } });
  } else {
    await db.user.create({
      data: { orgId: org.id, email: account.email, name: account.name, passwordHash, accessRole: account.accessRole },
    });
  }
  return { email: account.email, password };
}

/** Kept for the notetaker sandbox check: any user at this address marks a demo org. */
export const DEMO_EMAIL = DEMO_ACCOUNTS.manager.email;
