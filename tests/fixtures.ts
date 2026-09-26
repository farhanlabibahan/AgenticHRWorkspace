import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

export const DAY = 86_400_000;
/** Fixed origin so date math in expectations is exact. */
export const T0 = new Date('2026-01-05T00:00:00Z').getTime();
export const day = (n: number) => new Date(T0 + n * DAY);

/** A fresh org with ordered stages and one admin. Every test gets its own. */
export async function createOrg(stageNames = ['Applied', 'Screen', 'On-site', 'Hired']) {
  const org = await db.organization.create({
    data: { name: 'Test Co', slug: `t-${randomUUID().slice(0, 12)}`, onboardedAt: new Date() },
  });
  const types = ['APPLICANT', 'SCREEN', 'ONSITE', 'OFFER', 'HIRED'] as const;
  const stages = [];
  for (const [order, name] of stageNames.entries()) {
    stages.push(
      await db.stage.create({
        data: {
          orgId: org.id,
          name,
          order,
          type: order === stageNames.length - 1 ? 'HIRED' : types[Math.min(order, 3)],
        },
      }),
    );
  }
  const admin = await db.user.create({
    data: { orgId: org.id, email: `admin-${org.slug}@test.local`, name: 'Admin', accessRole: 'SUPER_ADMIN' },
  });
  return { org, stages, admin };
}

/**
 * An opportunity that walked `path` (stage index → day entered). Transitions
 * are written exactly like the app writes them; the last one is current.
 */
export async function candidate(
  orgId: string,
  stages: { id: string }[],
  path: [stageIndex: number, day: number][],
  opts: {
    name?: string;
    status?: 'ACTIVE' | 'ARCHIVED' | 'HIRED';
    postingId?: string;
    ownerId?: string;
    headline?: string;
    tags?: string[];
    emails?: string[];
  } = {},
) {
  const [, firstDay] = path[0];
  const [lastStage, lastDay] = path[path.length - 1];
  const contact = await db.contact.create({
    data: {
      orgId,
      name: opts.name ?? `Person ${randomUUID().slice(0, 6)}`,
      headline: opts.headline ?? null,
      tags: opts.tags ?? [],
      emails: opts.emails ?? [],
      createdAt: day(firstDay),
    },
  });
  const opportunity = await db.opportunity.create({
    data: {
      orgId,
      contactId: contact.id,
      postingId: opts.postingId ?? null,
      ownerId: opts.ownerId ?? null,
      stageId: stages[lastStage].id,
      status: opts.status ?? 'ACTIVE',
      stageChangedAt: day(lastDay),
      createdAt: day(firstDay),
    },
  });
  let from: string | null = null;
  for (const [stageIndex, d] of path) {
    await db.stageTransition.create({
      data: { opportunityId: opportunity.id, fromStageId: from, toStageId: stages[stageIndex].id, occurredAt: day(d) },
    });
    from = stages[stageIndex].id;
  }
  return { contact, opportunity };
}
