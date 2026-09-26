import type { ApprovalState, ApprovalSubject, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';

type Tx = Prisma.TransactionClient;

export type PendingApproval = {
  id: string;
  subjectType: ApprovalSubject;
  subjectId: string;
  title: string;
  href: string;
  comment: string | null;
  createdAt: Date;
  requestedByName: string | null;
};

/** Open (or reuse) a pending approval for a posting/offer/req. */
export async function requestApproval(
  tx: Tx,
  input: {
    orgId: string;
    actor: SessionContext;
    subjectType: ApprovalSubject;
    subjectId: string;
    title: string;
    href: string;
    comment?: string;
  },
) {
  const existing = await tx.approvalRequest.findFirst({
    where: {
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      state: 'PENDING',
    },
  });
  if (existing) return existing;

  const request = await tx.approvalRequest.create({
    data: {
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      href: input.href,
      comment: input.comment ?? null,
      requestedById: input.actor.userId,
    },
  });
  return request;
}

export async function closePendingApprovals(
  tx: Tx,
  input: {
    orgId: string;
    actor: SessionContext;
    subjectType: ApprovalSubject;
    subjectId: string;
    state: Exclude<ApprovalState, 'PENDING'>;
    resolution?: string;
  },
) {
  const pending = await tx.approvalRequest.findMany({
    where: {
      orgId: input.orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      state: 'PENDING',
    },
  });
  for (const req of pending) {
    await tx.approvalRequest.update({
      where: { id: req.id },
      data: {
        state: input.state,
        resolvedById: input.actor.userId,
        resolution: input.resolution ?? null,
        resolvedAt: new Date(),
      },
    });
  }
}

export function listPendingApprovals(orgId: string): Promise<PendingApproval[]> {
  return db.approvalRequest.findMany({
    where: { orgId, state: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { requestedBy: { select: { name: true } } },
  }).then((rows) =>
    rows.map((r) => ({
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      title: r.title,
      href: r.href,
      comment: r.comment,
      createdAt: r.createdAt,
      requestedByName: r.requestedBy?.name ?? null,
    })),
  );
}

export async function getPendingApproval(ctx: SessionContext, requestId: string) {
  const request = await db.approvalRequest.findFirst({
    where: { id: requestId, orgId: ctx.orgId, state: 'PENDING' },
  });
  if (!request) throw new Error('Approval request not found');
  return request;
}
