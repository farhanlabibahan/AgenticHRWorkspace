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

/** The one company this deployment documents. Demo and sample tenants are excluded. */
export async function getCentralDocsOrg() {
  const slug = process.env.DOCS_ORG_SLUG;
  if (slug) return db.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
  const organizations = await db.organization.findMany({
    where: { NOT: { OR: [{ slug: { startsWith: 'demo' } }, { slug: { startsWith: 'sample-' } }] } },
    take: 2,
    select: { id: true, name: true },
  });
  return organizations.length === 1 ? organizations[0] : null;
}

export async function getLiveDocsData(orgId: string) {
  const [users, postings, opportunities, interviews, events, attendance, leaveRequests, agentRuns, apiKeys, webhooks, latestEvent, org] = await Promise.all([
    db.user.count({ where: { orgId, deactivatedAt: null } }),
    db.posting.count({ where: { orgId } }),
    db.opportunity.count({ where: { orgId } }),
    db.interview.count({ where: { orgId } }),
    db.event.count({ where: { orgId } }),
    db.attendance.count({ where: { orgId } }),
    db.leaveRequest.count({ where: { orgId } }),
    db.agentRun.count({ where: { orgId } }),
    db.apiKey.count({ where: { orgId } }),
    db.webhookEndpoint.count({ where: { orgId } }),
    db.event.findFirst({ where: { orgId }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
    db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { talentNetworkEnabled: true, requirePostingApproval: true, autoScheduleOnInterviewStages: true } }),
  ]);
  return { users, postings, opportunities, interviews, events, attendance, leaveRequests, agentRuns,
    apiKeys, webhooks, latestEventAt: latestEvent?.occurredAt.toISOString() ?? null,
    features: { ai: aiConfigured(), talentNetwork: org.talentNetworkEnabled, postingApproval: org.requirePostingApproval,
      autoScheduling: org.autoScheduleOnInterviewStages }, asOf: new Date().toISOString() };
}

export const publicApi = [
  { method: 'GET/POST', path: '/api/v1/postings', purpose: 'Job postings' },
  { method: 'GET', path: '/api/v1/contacts', purpose: 'Candidate contacts' },
  { method: 'GET/POST', path: '/api/v1/opportunities', purpose: 'Applications and pipeline' },
  { method: 'GET', path: '/api/v1/events', purpose: 'Activity events' },
  { method: 'GET', path: '/api/v1/stages', purpose: 'Recruitment stages' },
];
