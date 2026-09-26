import type { Commitment, PostingState, WorkplaceType } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { closePendingApprovals, requestApproval } from '@/server/approvals';
import { isAdmin, type SessionContext } from '@/lib/session';
import { invalidateListMeta } from '@/server/lists/cache';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

export type CreatePostingInput = {
  title: string;
  departmentId?: string;
  clientCompanyId?: string;
  location?: string;
  workplaceType: WorkplaceType;
  commitment: Commitment;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  description?: string;
};

export async function createPosting(ctx: SessionContext, input: CreatePostingInput) {
  const baseSlug = slugify(input.title) || 'role';
  const existing = await db.posting.findUnique({
    where: { orgId_slug: { orgId: ctx.orgId, slug: baseSlug } },
  });
  const slug = existing ? `${baseSlug}-${Math.random().toString(36).slice(2, 7)}` : baseSlug;

  if (input.departmentId) {
    const dept = await db.department.findFirst({
      where: { id: input.departmentId, orgId: ctx.orgId },
    });
    if (!dept) throw new Error('Department not found');
  }
  if (input.clientCompanyId) {
    const client = await db.clientCompany.findFirst({
      where: { id: input.clientCompanyId, orgId: ctx.orgId },
    });
    if (!client) throw new Error('Client not found');
  }

  const created = await db.$transaction(async (tx) => {
    const posting = await tx.posting.create({
      data: {
        orgId: ctx.orgId,
        slug,
        title: input.title,
        departmentId: input.departmentId || null,
        clientCompanyId: input.clientCompanyId || null,
        location: input.location || null,
        workplaceType: input.workplaceType,
        commitment: input.commitment,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        salaryCurrency: input.salaryCurrency || null,
        content: input.description ? { description: input.description } : undefined,
        // whoever opens the role owns it until someone hands it over
        ownerId: ctx.userId ?? null,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'posting.created',
      subjectType: 'posting',
      subjectId: posting.id,
      payload: { title: posting.title },
    });
    return posting;
  });
  invalidateListMeta(ctx.orgId);
  return created;
}

export async function setPostingState(ctx: SessionContext, postingId: string, state: PostingState) {
  return db.$transaction(async (tx) => {
    const posting = await tx.posting.findFirst({
      where: { id: postingId, orgId: ctx.orgId },
    });
    if (!posting) throw new Error('Posting not found');

    // Approval chain: when the org requires it, a member's "publish"
    // becomes a request — only admins can take a posting live.
    const admin = isAdmin(ctx);
    let effective = state;
    let verb =
      state === 'PUBLISHED'
        ? 'posting.published'
        : state === 'CLOSED'
          ? 'posting.closed'
          : 'posting.state_changed';
    if (state === 'PUBLISHED' && !admin) {
      const org = await tx.organization.findUnique({
        where: { id: ctx.orgId },
        select: { requirePostingApproval: true },
      });
      if (org?.requirePostingApproval) {
        effective = 'PENDING_APPROVAL';
        verb = 'posting.approval_requested';
      }
    }
    if (state === 'PUBLISHED' && admin && posting.state === 'PENDING_APPROVAL') {
      verb = 'posting.approved';
    }
    if (state === 'DRAFT' && admin && posting.state === 'PENDING_APPROVAL') {
      verb = 'posting.approval_rejected';
    }

    if (effective === 'PENDING_APPROVAL') {
      await requestApproval(tx, {
        orgId: ctx.orgId,
        actor: ctx,
        subjectType: 'POSTING',
        subjectId: posting.id,
        title: posting.title,
        href: `/postings/${posting.id}`,
      });
    } else if (posting.state === 'PENDING_APPROVAL') {
      await closePendingApprovals(tx, {
        orgId: ctx.orgId,
        actor: ctx,
        subjectType: 'POSTING',
        subjectId: posting.id,
        state: effective === 'PUBLISHED' ? 'APPROVED' : 'REJECTED',
      });
    }

    const updated = await tx.posting.update({
      where: { id: posting.id },
      data: { state: effective },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb,
      subjectType: 'posting',
      subjectId: posting.id,
      payload: { title: posting.title, from: posting.state, to: effective },
    });
    return updated;
  });
}

export function listPostings(ctx: SessionContext) {
  return db.posting.findMany({
    // The filtered _count is faster as a separate query than as a join.
    relationLoadStrategy: 'query',
    where: { orgId: ctx.orgId },
    orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
    include: {
      department: true,
      clientCompany: true,
      _count: { select: { opportunities: { where: { status: 'ACTIVE' } } } },
    },
  });
}

/** Hand a role to a recruiter (or to nobody, with null). Both must be in the org. */
export async function setPostingOwner(ctx: SessionContext, postingId: string, ownerId: string | null) {
  const [posting, owner] = await Promise.all([
    db.posting.findFirst({ where: { id: postingId, orgId: ctx.orgId }, select: { id: true, title: true } }),
    ownerId
      ? db.user.findFirst({ where: { id: ownerId, orgId: ctx.orgId, deactivatedAt: null }, select: { id: true, name: true } })
      : null,
  ]);
  if (!posting) throw new Error('Posting not found');
  if (ownerId && !owner) throw new Error('That teammate isn’t in this workspace.');
  return db.$transaction(async (tx) => {
    await tx.posting.update({ where: { id: posting.id }, data: { ownerId } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'posting.owner_changed',
      subjectType: 'posting',
      subjectId: posting.id,
      payload: { title: posting.title, owner: owner?.name ?? null },
    });
  });
}
