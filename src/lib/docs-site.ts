import { db } from '@/lib/db';
import { aiConfigured } from '@/server/ai-client';

export const DOC_KEYS = ['headline', 'elevatorPitch', 'summary', 'problem', 'solution', 'market', 'businessModel', 'traction', 'roadmap', 'ask', 'architecture', 'dataFlow', 'stack'] as const;
export type DocKey = (typeof DOC_KEYS)[number];
export type DocsContent = Record<DocKey, string>;
export type DocsMember = { id: string; name: string; role: string; email: string; image: string };

export const defaultContent: DocsContent = {
  headline: 'Small teams. Extraordinary possibilities.',
  elevatorPitch: 'Orqestra brings recruiting and people operations into one open-source workspace.',
  summary: 'A connected workspace for hiring, employee operations, and practical AI assistance.',
  problem: 'Growing teams often manage applications, interviews, attendance, and leave across disconnected tools. Administrative work grows faster than the team.',
  solution: 'Orqestra connects job posting, applicant tracking, interview feedback, attendance, leave, and workforce insights in one place.',
  market: 'Teams that need structured hiring and people operations without assembling a patchwork of systems.',
  businessModel: 'Open-source software that organizations can self-host and extend.',
  traction: 'Add verified customer, adoption, or usage evidence here before publishing.',
  roadmap: 'Describe the next product milestones and their expected timing.',
  ask: 'Describe the support, partnership, or investment sought.',
  architecture: 'Browser → Next.js application → server actions and API routes → PostgreSQL. Optional services provide storage, email, and AI capabilities.',
  dataFlow: 'A candidate applies → an application and resume are stored → the hiring team reviews and advances the candidate → interviews and feedback inform a decision → employee operations begin after hiring.',
  stack: 'Next.js, React, TypeScript, Prisma, PostgreSQL, Tailwind CSS. Optional AI provider, object storage, and email integrations.',
};

export function readContent(value: unknown): DocsContent {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(DOC_KEYS.map((key) => [key, typeof data[key] === 'string' ? data[key] : defaultContent[key]])) as DocsContent;
}

export function readTeam(value: unknown): DocsMember[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is DocsMember => row && typeof row === 'object' &&
    typeof row.id === 'string' && typeof row.name === 'string' && typeof row.role === 'string' &&
    typeof row.email === 'string' && typeof row.image === 'string').slice(0, 30);
}

export function isPublished(site: { enabled: boolean; startsAt: Date | null; endsAt: Date | null }, now = new Date()) {
  return site.enabled && (!site.startsAt || site.startsAt <= now) && (!site.endsAt || site.endsAt > now);
}

/** Storage owner for the central document. Demo and sample tenants never own it. */
export async function getCentralDocsOrg() {
  const slug = process.env.DOCS_ORG_SLUG;
  if (slug) return db.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
  const realOrg = { NOT: { OR: [{ slug: { startsWith: 'demo' } }, { slug: { startsWith: 'sample-' } }] } };
  const existing = await db.organization.findFirst({
    where: { ...realOrg, docsSite: { isNot: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  return existing ?? db.organization.findFirst({ where: realOrg, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
}

export async function getLiveDocsData() {
  const organizations = await db.organization.findMany({
    where: { NOT: { OR: [{ slug: { startsWith: 'demo' } }, { slug: { startsWith: 'sample-' } }] } },
    select: { id: true, talentNetworkEnabled: true, requirePostingApproval: true, autoScheduleOnInterviewStages: true },
  });
  const scope = { orgId: { in: organizations.map((org) => org.id) } };
  const [users, postings, opportunities, interviews, events, attendance, leaveRequests, agentRuns, apiKeys, webhooks, latestEvent] = await Promise.all([
    db.user.count({ where: { ...scope, deactivatedAt: null } }),
    db.posting.count({ where: scope }),
    db.opportunity.count({ where: scope }),
    db.interview.count({ where: scope }),
    db.event.count({ where: scope }),
    db.attendance.count({ where: scope }),
    db.leaveRequest.count({ where: scope }),
    db.agentRun.count({ where: scope }),
    db.apiKey.count({ where: scope }),
    db.webhookEndpoint.count({ where: scope }),
    db.event.findFirst({ where: scope, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
  ]);
  return { users, postings, opportunities, interviews, events, attendance, leaveRequests, agentRuns,
    apiKeys, webhooks, latestEventAt: latestEvent?.occurredAt.toISOString() ?? null,
    features: { ai: aiConfigured(), talentNetwork: organizations.some((org) => org.talentNetworkEnabled),
      postingApproval: organizations.some((org) => org.requirePostingApproval),
      autoScheduling: organizations.some((org) => org.autoScheduleOnInterviewStages) },
    asOf: new Date().toISOString() };
}

export const publicApi = [
  { method: 'GET/POST', path: '/api/v1/postings', purpose: 'Job postings' },
  { method: 'GET', path: '/api/v1/contacts', purpose: 'Candidate contacts' },
  { method: 'GET/POST', path: '/api/v1/opportunities', purpose: 'Applications and pipeline' },
  { method: 'GET', path: '/api/v1/events', purpose: 'Activity events' },
  { method: 'GET', path: '/api/v1/stages', purpose: 'Recruitment stages' },
];
