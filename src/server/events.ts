import type { Prisma } from '@prisma/client';

type EventInput = {
  orgId: string;
  actorType: 'user' | 'api_key' | 'system' | 'candidate';
  actorId?: string | null;
  verb: string;
  subjectType: string;
  subjectId: string;
  payload?: Prisma.InputJsonValue;
};

type Tx = Prisma.TransactionClient;

/** Resolve the event actor from a session or API-key context. */
export function actorOf(ctx: { userId: string | null; apiKeyId?: string }): {
  actorType: 'user' | 'api_key';
  actorId: string | null;
} {
  if (ctx.userId) return { actorType: 'user', actorId: ctx.userId };
  return { actorType: 'api_key', actorId: ctx.apiKeyId ?? null };
}

/**
 * Append to the org's immutable event stream. Every domain mutation calls
 * this inside its transaction — the stream powers activity feeds, audit,
 * webhooks, automations, and analytics (see docs/03-architecture.md).
 */
export function emitEvent(tx: Tx, event: EventInput) {
  return tx.event.create({
    data: {
      orgId: event.orgId,
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      verb: event.verb,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      payload: event.payload,
    },
  });
}
