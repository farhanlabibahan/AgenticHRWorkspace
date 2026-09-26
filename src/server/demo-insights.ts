import { Prisma } from '@prisma/client';
import { EMPTY_FACTS, qaFromDialogue, type InterviewFacts, type TranscriptInsights } from '@/lib/interview-insights';

/**
 * Interview questions and stated facts for the demo, without a model: the
 * demo's transcripts are "Speaker: words" dialogue, which reads directly.
 * Maya also gets a recruiter screen whose facts are written out here, so
 * Key facts has something to show.
 */

export const DEMO_SCREEN_TITLE = 'Recruiter screen — Maya Chen';

const MAYA_SCREEN = [
  'Interviewer: Thanks for making time, Maya. What has you looking right now?',
  'Maya: The design system at Figment is in good hands now. I want a product where the dense, everyday workflows are the whole point, and recruiting tools are exactly that.',
  'Interviewer: Where are you based, and would you consider moving?',
  'Maya: I’m in Brooklyn. I’d rather stay in New York, but I’d relocate for the right team, and I’m happy to travel for on-sites.',
  'Interviewer: Are you authorized to work in the US, and would you need sponsorship?',
  'Maya: Yes, I’m authorized to work in the US and I won’t need sponsorship.',
  'Interviewer: When could you start?',
  'Maya: I’d give Figment four weeks’ notice, so early next quarter.',
  'Interviewer: What would you want to learn in your first 90 days?',
  'Maya: How recruiters actually triage a busy pipeline. I’d sit in on a few screens before touching the board.',
].join('\n');

const MAYA_FACTS: InterviewFacts = {
  motivation: 'Wants to work on dense, everyday workflows like recruiting tools',
  location: 'Brooklyn, NY',
  relocation: 'Prefers New York; would relocate for the right team',
  workAuthorization: 'Authorized to work in the US; no sponsorship needed',
  availability: 'Four weeks’ notice',
};

const insights = (content: string, facts: InterviewFacts = EMPTY_FACTS): TranscriptInsights => ({
  qa: qaFromDialogue(content),
  facts,
  model: 'Sample',
  at: new Date().toISOString(),
});

export async function seedTranscriptInsights(tx: Prisma.TransactionClient, orgId: string) {
  const maya = await tx.opportunity.findFirst({
    where: { orgId, contact: { emails: { has: 'maya.chen@example.com' } }, posting: { slug: 'senior-product-designer' } },
    select: { id: true },
  });
  if (maya && !(await tx.transcript.findFirst({ where: { orgId, title: DEMO_SCREEN_TITLE }, select: { id: true } }))) {
    await tx.transcript.create({
      data: {
        orgId,
        opportunityId: maya.id,
        title: DEMO_SCREEN_TITLE,
        source: 'manual',
        content: MAYA_SCREEN,
        insights: insights(MAYA_SCREEN, MAYA_FACTS) as Prisma.InputJsonValue,
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });
  }
  const unread = await tx.transcript.findMany({
    where: { orgId, insights: { equals: Prisma.DbNull } },
    select: { id: true, content: true },
    take: 50,
  });
  for (const t of unread) {
    await tx.transcript.update({ where: { id: t.id }, data: { insights: insights(t.content) as Prisma.InputJsonValue } });
  }
}
