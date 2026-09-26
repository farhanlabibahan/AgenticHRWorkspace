import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import type { AccessRole } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';

/**
 * Team management. Invites work without an email round-trip (self-hosted
 * deployments may have no SMTP): the admin gets a one-time temporary
 * password to hand to the teammate, who signs in and keeps working. All
 * changes land in the audit stream.
 */

function requireAdmin(ctx: SessionContext) {
  if (ctx.accessRole !== 'SUPER_ADMIN' && ctx.accessRole !== 'ADMIN')
    throw new Error('Admins only');
}

export async function inviteUser(
  ctx: SessionContext,
  input: { email: string; name: string; accessRole: AccessRole },
): Promise<{ tempPassword: string }> {
  requireAdmin(ctx);
  const email = input.email.toLowerCase().trim();
  if (!email || !input.name.trim()) throw new Error('Name and email are required');
  const existing = await db.user.findUnique({
    where: { orgId_email: { orgId: ctx.orgId, email } },
  });
  if (existing) throw new Error('A teammate with this email already exists');

  const tempPassword = randomBytes(9).toString('base64url');
  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        orgId: ctx.orgId,
        email,
        name: input.name.trim(),
        passwordHash: bcrypt.hashSync(tempPassword, 10),
        accessRole: input.accessRole,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'user.invited',
      subjectType: 'user',
      subjectId: user.id,
      payload: { email, accessRole: input.accessRole },
    });
  });
  return { tempPassword };
}

export async function setUserRole(ctx: SessionContext, userId: string, accessRole: AccessRole) {
  requireAdmin(ctx);
  return db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, orgId: ctx.orgId } });
    if (!user) throw new Error('User not found');
    if (user.accessRole === 'SUPER_ADMIN' && ctx.accessRole !== 'SUPER_ADMIN')
      throw new Error('Only a super admin can change a super admin');
    const updated = await tx.user.update({ where: { id: user.id }, data: { accessRole } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'user.role_changed',
      subjectType: 'user',
      subjectId: user.id,
      payload: { email: user.email, accessRole },
    });
    return updated;
  });
}

export async function setUserActive(ctx: SessionContext, userId: string, active: boolean) {
  requireAdmin(ctx);
  if (userId === ctx.userId && !active) throw new Error('You cannot deactivate yourself');
  return db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, orgId: ctx.orgId } });
    if (!user) throw new Error('User not found');
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { deactivatedAt: active ? null : new Date() },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: active ? 'user.reactivated' : 'user.deactivated',
      subjectType: 'user',
      subjectId: user.id,
      payload: { email: user.email },
    });
    return updated;
  });
}
