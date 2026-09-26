import { Prisma } from '@prisma/client';
import { computeMatchScore, type CriterionResult, type MatchCriterion } from '@/lib/match-criteria';

/**
 * Match criteria for the demo's roles, and how the four sample evaluations
 * scored on them, so the demo shows a match without calling a model. Only
 * roles with no criteria and sample evaluations with no scores are touched:
 * the shared demo may have edited the rest.
 */

const ROLE_CRITERIA: Record<string, MatchCriterion[]> = {
  'senior-product-designer': [
    { id: 'c1', label: 'Senior-level product design', must: true },
    { id: 'c2', label: 'Design systems', must: true },
    { id: 'c3', label: 'Data-dense B2B workflows', must: false },
    { id: 'c4', label: 'Prototyping in code', must: false },
    { id: 'c5', label: 'Recruiting or HR tech', must: false },
    { id: 'c6', label: 'Research with customers', must: false },
  ],
  'founding-engineer': [
    { id: 'c1', label: 'TypeScript and React in production', must: true },
    { id: 'c2', label: 'Postgres and data modeling', must: true },
    { id: 'c3', label: 'Owned a product end to end', must: true },
    { id: 'c4', label: 'Early-stage startup', must: false },
    { id: 'c5', label: 'Scaled a product under load', must: false },
    { id: 'c6', label: 'Mentoring', must: false },
  ],
  'design-engineer': [
    { id: 'c1', label: 'Interface craft and polish', must: true },
    { id: 'c2', label: 'React and CSS', must: true },
    { id: 'c3', label: 'Design systems', must: false },
    { id: 'c4', label: 'Accessibility', must: false },
    { id: 'c5', label: 'Motion and interaction', must: false },
  ],
  'head-of-people': [
    { id: 'c1', label: 'Built a people function at a startup', must: true },
    { id: 'c2', label: 'Hiring at scale', must: true },
    { id: 'c3', label: 'Employment law and compliance', must: false },
    { id: 'c4', label: 'Compensation design', must: false },
    { id: 'c5', label: 'Coaching managers', must: false },
  ],
};

/** Per sample candidate: criterion id → [score, evidence]. A null score has no evidence. */
const SAMPLE_SCORES: Record<string, { posting: string; scores: Record<string, [number | null, string]> }> = {
  'maya.chen@example.com': {
    posting: 'senior-product-designer',
    scores: {
      c1: [100, 'Senior Product Designer at Figment since 2022, seven years in B2B SaaS.'],
      c2: [100, 'Built and maintains the design system 40 engineers ship from.'],
      c3: [50, 'Designed a reporting suite at Lumen Analytics; less time in dense operational tools.'],
      c4: [100, 'Prototypes in code with React and Tailwind.'],
      c5: [null, ''],
      c6: [100, 'Ran weekly customer interviews and turned them into a shared research library.'],
    },
  },
  'jordan.alvarez@example.com': {
    posting: 'senior-product-designer',
    scores: {
      c1: [100, 'Senior Designer at Northbeam after leading design at Hireloop.'],
      c2: [75, 'Built a token-based design system mirrored in Figma and React.'],
      c3: [100, 'Attribution reporting for 2,000 teams, and an ATS pipeline board before that.'],
      c4: [50, 'The design system is mirrored in React; no prototyping in code mentioned.'],
      c5: [100, 'Led design for an applicant tracking system at Hireloop.'],
      c6: [75, 'Redesigns tied to measured outcomes, like a 30% drop in time-to-first-touch.'],
    },
  },
  'priya.nair@example.com': {
    posting: 'senior-product-designer',
    scores: {
      c1: [100, 'Design Lead at Meridian Health; eight years in product design.'],
      c2: [75, 'Runs an accessibility review every release goes through; design systems listed as a skill.'],
      c3: [75, 'Patient intake and scheduling products used in 300 clinics.'],
      c4: [null, ''],
      c5: [0, 'No recruiting or HR product work in the resume.'],
      c6: [100, 'Took care-team messaging from first sketch to launch, research-led.'],
    },
  },
  'sam.whitfield@example.com': {
    posting: 'founding-engineer',
    scores: {
      c1: [100, 'TypeScript and Next.js for six years; led a typed API layer at Relay.'],
      c2: [100, 'Postgres and Prisma in production; maintains a Prisma extension.'],
      c3: [100, 'Owns products end to end, from the schema to the empty state.'],
      c4: [50, 'Relay and Parcelwise are growth-stage; no founding-team role yet.'],
      c5: [100, 'Scaled the marketplace from 10,000 to 2 million users.'],
      c6: [100, 'Mentors four engineers at Relay.'],
    },
  },
};

export async function seedMatchCriteria(tx: Prisma.TransactionClient, orgId: string, sampleModel: string) {
  for (const [slug, criteria] of Object.entries(ROLE_CRITERIA)) {
    await tx.posting.updateMany({
      where: { orgId, slug, matchCriteria: { equals: Prisma.DbNull } },
      data: { matchCriteria: criteria as Prisma.InputJsonValue },
    });
  }
  for (const [email, sample] of Object.entries(SAMPLE_SCORES)) {
    const criteria = ROLE_CRITERIA[sample.posting];
    const results: CriterionResult[] = criteria.map((c) => {
      const [score, evidence] = sample.scores[c.id] ?? [null, ''];
      return { ...c, score, evidence };
    });
    await tx.aiEvaluation.updateMany({
      where: {
        orgId,
        model: sampleModel,
        criteria: { equals: Prisma.DbNull },
        opportunity: { contact: { emails: { has: email } }, posting: { slug: sample.posting } },
      },
      data: { criteria: results as Prisma.InputJsonValue, matchScore: computeMatchScore(results) },
    });
  }
}

/** Whether the demo's roles have their criteria yet. */
export const criteriaSeededWhere = (orgId: string): Prisma.PostingWhereInput => ({
  orgId,
  slug: 'senior-product-designer',
  NOT: { matchCriteria: { equals: Prisma.DbNull } },
});

/** Career highlights the sample evaluations would have found (promotions come from the resumes). */
const SAMPLE_HIGHLIGHTS: Record<string, { kind: string; text: string }[]> = {
  'maya.chen@example.com': [
    { kind: 'craft', text: 'Built a design system at scale' },
    { kind: 'launch', text: 'Reporting suite from zero' },
  ],
  'jordan.alvarez@example.com': [
    { kind: 'launch', text: 'Designed an ATS before' },
    { kind: 'range', text: 'Startup and freelance' },
  ],
  'sam.whitfield@example.com': [
    { kind: 'scale', text: 'Scaled 10k to 2M users' },
    { kind: 'leadership', text: 'Mentors four engineers' },
  ],
  'priya.nair@example.com': [
    { kind: 'leadership', text: 'Leads a team of five' },
    { kind: 'craft', text: 'Accessibility lead (WCAG 2.2)' },
  ],
};

export async function seedSampleHighlights(tx: Prisma.TransactionClient, orgId: string, sampleModel: string) {
  for (const [email, highlights] of Object.entries(SAMPLE_HIGHLIGHTS)) {
    await tx.aiEvaluation.updateMany({
      where: { orgId, model: sampleModel, highlights: { equals: Prisma.DbNull }, opportunity: { contact: { emails: { has: email } } } },
      data: { highlights: highlights as Prisma.InputJsonValue },
    });
  }
}
