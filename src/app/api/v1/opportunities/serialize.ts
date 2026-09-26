import type { Prisma } from '@prisma/client';

export const opportunityInclude = {
  contact: true,
  stage: true,
  posting: true,
  archiveReason: true,
} satisfies Prisma.OpportunityInclude;

type OpportunityWithRelations = Prisma.OpportunityGetPayload<{
  include: typeof opportunityInclude;
}>;

export function serializeOpportunity(opp: OpportunityWithRelations) {
  return {
    id: opp.id,
    status: opp.status.toLowerCase(),
    origin: opp.origin.toLowerCase(),
    source: opp.source,
    stage: { id: opp.stageId, name: opp.stage.name, type: opp.stage.type.toLowerCase() },
    stage_changed_at: opp.stageChangedAt.toISOString(),
    posting_id: opp.postingId,
    posting_title: opp.posting?.title ?? null,
    archive_reason: opp.archiveReason?.name ?? null,
    contact: {
      id: opp.contact.id,
      name: opp.contact.name,
      headline: opp.contact.headline,
      emails: opp.contact.emails,
      location: opp.contact.location,
      links: opp.contact.links,
    },
    created_at: opp.createdAt.toISOString(),
  };
}
