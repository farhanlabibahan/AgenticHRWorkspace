import { createHash } from 'crypto';
import type { Prisma, StageType } from '@prisma/client';
import { scrub } from '@/server/imports/text';
import type { CatalogReason, CatalogStage, CatalogUser, CatalogWriter, ReasonKind } from '@/server/imports/types';
import { inferStageType, TYPE_RANK } from '@/lib/stage-types';

export { inferStageType, TYPE_RANK };

/**
 * Stage & reason mapping. Vendors model pipelines differently (Greenhouse
 * and Ashby give every job its own stage list; Lever has one org list), so
 * discovery groups stages by normalized name: fifty jobs' "Phone Screen"
 * stages become one row the admin maps once.
 */

export const STAGE_TYPES: StageType[] = ['LEAD', 'APPLICANT', 'SCREEN', 'ONSITE', 'OFFER', 'HIRED'];

export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Looser match for pairing a vendor's name with one already in Source:
 * letters and digits only, accents dropped — "Onsite", "On-site" and
 * "on site" are the same stage. Used for suggestions, never for grouping.
 */
export function looseKey(name: string): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return base.replace(/[^\p{L}\p{N}]+/gu, '') || base.trim();
}

/** Deterministic posting slug per vendor posting, so re-runs reuse it. */
export function externalSlug(title: string, provider: string, externalId: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'role';
  const hash = createHash('sha1').update(`${provider}:${externalId}`).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

// ---------- Catalog (what discovery found) ----------

export type CatalogStageGroup = {
  key: string;
  name: string;
  externalIds: string[];
  typeHint: StageType | null;
  /** Mean position across the vendor pipelines this name appears in. */
  position: number | null;
  /** How many positions the mean covers (so replays and resumes don't skew it). */
  samples?: number;
};

export type CatalogReasonGroup = { key: string; name: string; externalIds: string[]; kind: ReasonKind };

export type Catalog = {
  stages: CatalogStageGroup[];
  reasons: CatalogReasonGroup[];
  users: CatalogUser[];
};

export function emptyCatalog(): Catalog {
  return { stages: [], reasons: [], users: [] };
}

export function parseCatalog(value: Prisma.JsonValue | null | undefined): Catalog {
  const c = (value ?? {}) as Partial<Catalog>;
  return { stages: c.stages ?? [], reasons: c.reasons ?? [], users: c.users ?? [] };
}

/** Mutable writer over a catalog; discover phases may replay, so everything dedupes. */
export function catalogWriter(catalog: Catalog): CatalogWriter {
  const stageByKey = new Map(catalog.stages.map((g) => [g.key, g]));
  const reasonByKey = new Map(catalog.reasons.map((g) => [g.key, g]));
  const userIds = new Set(catalog.users.map((u) => u.externalId));

  return {
    stage(s: CatalogStage) {
      s = scrub(s);
      const name = s.name.trim();
      if (!name) return;
      const key = nameKey(name);
      let group = stageByKey.get(key);
      if (!group) {
        group = { key, name, externalIds: [], typeHint: null, position: null, samples: 0 };
        stageByKey.set(key, group);
        catalog.stages.push(group);
      }
      if (!group.typeHint && s.typeHint) group.typeHint = s.typeHint;
      if (group.externalIds.includes(s.externalId)) return; // replayed step
      group.externalIds.push(s.externalId);
      if (s.position != null) {
        const n = group.samples ?? 0;
        group.position = ((group.position ?? 0) * n + s.position) / (n + 1);
        group.samples = n + 1;
      }
    },
    reason(r: CatalogReason) {
      r = scrub(r);
      const name = r.name.trim();
      if (!name) return;
      const key = nameKey(name);
      let group = reasonByKey.get(key);
      if (!group) {
        group = { key, name, externalIds: [], kind: r.kind };
        reasonByKey.set(key, group);
        catalog.reasons.push(group);
      }
      if (!group.externalIds.includes(r.externalId)) group.externalIds.push(r.externalId);
    },
    user(u: CatalogUser) {
      u = scrub(u);
      if (userIds.has(u.externalId)) return;
      userIds.add(u.externalId);
      catalog.users.push({ ...u, email: u.email?.trim().toLowerCase() || null });
    },
  };
}

// ---------- Mapping (what the admin confirmed) ----------

export type StageTarget = { stageId: string } | { create: { name: string; type: StageType } };
/**
 * Source's reports count a reason as a rejection only when the org turned the
 * candidate down (see the default "Withdrew" / "Timing" reasons). Candidate
 * withdrawals and hires don't inflate rejection metrics; unknowns do, as the
 * conservative read.
 */
export function countsAsRejection(kind: ReasonKind): boolean {
  return kind === 'rejection' || kind === 'other';
}

export type ReasonTarget = { reasonId: string } | { create: { name: string; countsAsRejection: boolean } };

export type MappingInput = {
  stages: Record<string, StageTarget>;
  reasons: Record<string, ReasonTarget>;
  /**
   * A brand-new workspace (no applications yet) can drop Source's starter
   * stages that no vendor stage maps to, so its pipeline is the vendor's.
   */
  replaceStarters?: boolean;
};

/** Stored on the job after apply: normalized name → Source id. */
export type AppliedMapping = {
  stages: Record<string, string>;
  reasons: Record<string, string>;
};

export function parseMapping(value: Prisma.JsonValue | null | undefined): AppliedMapping {
  const m = (value ?? {}) as Partial<AppliedMapping>;
  return { stages: m.stages ?? {}, reasons: m.reasons ?? {} };
}

type OrgStage = { id: string; name: string; type: StageType };
type OrgReason = { id: string; name: string };

/**
 * Default mapping shown on the review screen: a previous import's choice for
 * the same vendor stage wins, then an existing stage with the same name,
 * otherwise create it with an inferred type.
 */
export function defaultMapping(
  catalog: Catalog,
  orgStages: OrgStage[],
  orgReasons: OrgReason[],
  previous: { stages: Map<string, string>; reasons: Map<string, string> },
): MappingInput {
  const stageByName = new Map(orgStages.map((s) => [looseKey(s.name), s.id]));
  const reasonByName = new Map(orgReasons.map((r) => [looseKey(r.name), r.id]));
  const stages: Record<string, StageTarget> = {};
  for (const g of catalog.stages) {
    const prior = g.externalIds.map((id) => previous.stages.get(id)).find(Boolean);
    const same = stageByName.get(looseKey(g.name));
    stages[g.key] = prior
      ? { stageId: prior }
      : same
        ? { stageId: same }
        : { create: { name: g.name, type: g.typeHint ?? inferStageType(g.name) } };
  }
  const reasons: Record<string, ReasonTarget> = {};
  for (const g of catalog.reasons) {
    const prior = g.externalIds.map((id) => previous.reasons.get(id)).find(Boolean);
    const same = reasonByName.get(looseKey(g.name));
    reasons[g.key] = prior
      ? { reasonId: prior }
      : same
        ? { reasonId: same }
        : { create: { name: g.name, countsAsRejection: countsAsRejection(g.kind) } };
  }
  return { stages, reasons };
}

/** Order newly created stages the way a pipeline reads: by type, then vendor position. */
export function orderNewStages<T extends { type: StageType; position: number | null }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || (a.position ?? 999) - (b.position ?? 999),
  );
}
