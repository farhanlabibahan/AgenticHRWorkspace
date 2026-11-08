import { createHmac, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';

/**
 * Signed webhook delivery, driven off the event stream (outbox pattern).
 * The dispatcher walks each endpoint's cursor through org events in order,
 * POSTs signed payloads, and retries failures on the next run — at-least-once,
 * per-endpoint ordering preserved. Wired to /api/cron/webhooks.
 */

const MAX_ATTEMPTS = 5;
const BATCH = 25;
const TIMEOUT_MS = 5_000;

export function signPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export async function createWebhookEndpoint(
  ctx: SessionContext,
  url: string,
  eventTypes: string[],
) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('URL must be http(s)');

  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const endpoint = await db.webhookEndpoint.create({
    data: {
      orgId: ctx.orgId,
      url,
      secret,
      eventTypes,
      lastEventAt: new Date(), // only deliver events from now on
    },
  });
  return { endpoint, secret };
}

export async function setWebhookActive(ctx: SessionContext, endpointId: string, active: boolean) {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, orgId: ctx.orgId },
  });
  if (!endpoint) throw new Error('Endpoint not found');
  return db.webhookEndpoint.update({ where: { id: endpoint.id }, data: { active } });
}

export async function deleteWebhookEndpoint(ctx: SessionContext, endpointId: string) {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, orgId: ctx.orgId },
  });
  if (!endpoint) throw new Error('Endpoint not found');
  return db.webhookEndpoint.delete({ where: { id: endpoint.id } });
}

/** Deliver pending events for every active endpoint. Returns delivery count. */
export async function processWebhooks(): Promise<number> {
  const endpoints = await db.webhookEndpoint.findMany({ where: { active: true } });
  let delivered = 0;

  for (const endpoint of endpoints) {
    const events = await db.event.findMany({
      where: {
        orgId: endpoint.orgId,
        occurredAt: { gt: endpoint.lastEventAt ?? endpoint.createdAt },
        ...(endpoint.eventTypes.length ? { verb: { in: endpoint.eventTypes } } : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: BATCH,
    });

    for (const event of events) {
      const delivery = await db.webhookDelivery.upsert({
        where: { endpointId_eventId: { endpointId: endpoint.id, eventId: event.id } },
        create: { endpointId: endpoint.id, eventId: event.id },
        update: {},
      });

      // Poison event: give up after MAX_ATTEMPTS and move the cursor past it
      if (delivery.attempts >= MAX_ATTEMPTS && !delivery.success) {
        await db.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { lastEventAt: event.occurredAt },
        });
        continue;
      }

      const body = JSON.stringify({
        id: event.id,
        type: event.verb,
        occurred_at: event.occurredAt.toISOString(),
        actor_type: event.actorType,
        subject_type: event.subjectType,
        subject_id: event.subjectId,
        data: event.payload ?? {},
      });
      const timestamp = Math.floor(Date.now() / 1000);

      let responseCode: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Source-Signature': signPayload(endpoint.secret, timestamp, body),
            'User-Agent': 'Orqestra-Webhooks/1.0',
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        responseCode = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const success = !error;
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          success,
          responseCode,
          error,
          lastAttemptAt: new Date(),
        },
      });

      if (!success) break; // keep ordering; retry this event next run

      await db.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { lastEventAt: event.occurredAt },
      });
      delivered += 1;
    }
  }
  return delivered;
}
