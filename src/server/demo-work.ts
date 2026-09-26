import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { seedDemoResumes, type DemoResume } from '@/server/demo-resume';

/**
 * Case studies for the demo's candidates, and a whole resume plus work for
 * the homepage's sample presentation, so both show what a finished
 * presentation looks like. The links are placeholders on example.com (the
 * domain reserved for examples), and there are no preview images: each
 * thumbnail is the generated one.
 */

type Work = { title: string; summary: string; slug: string };

const DEMO_WORK: Record<string, Work[]> = {
  'maya.chen@example.com': [
    { title: 'Onboarding that lifted activation 18%', summary: 'Figment’s first run, rebuilt: fewer steps, a real template, and a checklist that gets out of the way.', slug: 'maya-chen/onboarding' },
    { title: 'A design system 40 engineers ship from', summary: 'Tokens, components, and the monthly review that keeps them honest.', slug: 'maya-chen/design-system' },
    { title: 'Reporting for Lumen, from zero', summary: 'The reporting suite that took Lumen Analytics to 300 paying customers.', slug: 'maya-chen/lumen-reporting' },
  ],
  'jordan.alvarez@example.com': [
    { title: 'The pipeline board, rebuilt around stage aging', summary: 'How Hireloop’s recruiters stopped losing candidates past a few hundred.', slug: 'jordan-alvarez/stage-aging' },
    { title: 'Attribution reporting in minutes, not days', summary: 'Northbeam’s reporting redesign for 2,000 marketing teams.', slug: 'jordan-alvarez/attribution' },
    { title: 'A token-based design system in Figma and React', summary: 'One source of truth for design and code, and half the design QA.', slug: 'jordan-alvarez/tokens' },
  ],
  'priya.nair@example.com': [
    { title: 'Accessible intake for 300 clinics', summary: 'Taking Meridian Health’s patient intake to WCAG 2.2 AA, and keeping it there.', slug: 'priya-nair/accessible-intake' },
    { title: 'Care-team messaging, from sketch to launch', summary: 'CarePath’s messaging product, designed for very busy nurses.', slug: 'priya-nair/care-messaging' },
  ],
  'sam.whitfield@example.com': [
    { title: 'A typed API layer for Relay', summary: 'Moving a marketplace to typed endpoints without a freeze, and cutting p95 page loads by 60%.', slug: 'sam-whitfield/typed-api' },
    { title: 'prisma-soft-delete', summary: 'A small Prisma extension for soft deletes, maintained in the open.', slug: 'sam-whitfield/prisma-soft-delete' },
  ],
};

async function addWork(tx: Prisma.TransactionClient, orgId: string, contactId: string, work: Work[]) {
  await tx.caseStudy.createMany({
    data: work.map((w, position) => ({
      orgId,
      contactId,
      url: `https://example.com/${w.slug}`,
      title: w.title,
      summary: w.summary,
      position,
    })),
  });
}

/** The demo org's candidates, once: only people with no case studies yet. */
export async function seedDemoWork(tx: Prisma.TransactionClient, orgId: string) {
  for (const [email, work] of Object.entries(DEMO_WORK)) {
    const contact = await tx.contact.findFirst({
      where: { orgId, emails: { has: email }, caseStudies: { none: {} } },
      select: { id: true },
    });
    if (contact) await addWork(tx, orgId, contact.id, work);
  }
}

export const demoWorkSeeded = async (orgId: string) =>
  !!(await db.caseStudy.findFirst({ where: { orgId }, select: { id: true } }));

// ---- the homepage's sample presentation (sample-boards.ts) ----

const SAMPLE_RESUME: Omit<DemoResume, 'email'> = {
  resume: [
    'Product designer with eight years across B2B software, most recently leading design for Northbeam’s hiring platform.',
    '',
    'Northbeam — Design Lead, Hiring platform, Brooklyn, NY, Mar 2021–now. Built and ran a token-based design system mirrored in React; led the redesign of the candidate pipeline around stage aging.',
    '',
    'Tidewell Health — Product Designer, New York, NY, Jun 2018–Feb 2021. Care-coordination tools for nurses and care managers.',
    '',
    'Freelance — Product Designer, 2016–2018. Internal tools for logistics and fintech clients.',
    '',
    'BFA in Communication Design, Parsons School of Design, 2012–2016.',
  ].join('\n'),
  parsed: {
    summary:
      'Product designer with eight years across B2B software, most recently leading design for Northbeam’s hiring platform. I built and ran a token-based design system mirrored in React, which cut design QA time roughly in half, and led the redesign of the candidate pipeline around stage aging.\n\nBefore Northbeam I designed care-coordination tools at a digital health startup, where I learned to design for regulated workflows and very busy people.',
    skills: ['Design systems', 'Figma', 'Prototyping in React', 'User research', 'Information architecture', 'Healthcare UX', 'Workshop facilitation'],
    experience: [
      { title: 'Design Lead, Hiring platform', company: 'Northbeam', location: 'Brooklyn, NY', start: '2021-03', end: 'present' },
      { title: 'Product Designer', company: 'Tidewell Health', location: 'New York, NY', start: '2018-06', end: '2021-02' },
      { title: 'Product Designer', company: 'Freelance', location: 'Remote', start: '2016', end: '2018' },
    ],
    education: [{ school: 'Parsons School of Design', degree: 'BFA', field: 'Communication Design', start: '2012', end: '2016' }],
  },
};

const SAMPLE_WORK: Work[] = [
  { title: 'The candidate pipeline, rebuilt around stage aging', summary: 'Recruiters stopped losing people past a few hundred candidates; time to first touch fell about 30%.', slug: 'jordan-alvarez/stage-aging' },
  { title: 'A token-based design system, mirrored in React', summary: 'One source of truth for design and code, and half the design QA.', slug: 'jordan-alvarez/design-system' },
  { title: 'Care coordination for very busy nurses', summary: 'Tidewell Health’s care-team tools: fewer clicks between a page and the patient.', slug: 'jordan-alvarez/care-coordination' },
  { title: 'Reading a crowded dashboard at a glance', summary: 'Density versus scannability, settled with three rounds of testing.', slug: 'jordan-alvarez/density' },
];

/** The sample presentation's candidate gets a whole resume and their work. Idempotent; never throws. */
export async function ensureSampleWork(orgId: string, email: string) {
  try {
    const contact = await db.contact.findFirst({
      where: { orgId, emails: { has: email } },
      select: { id: true, resumeFileId: true, _count: { select: { caseStudies: true } } },
    });
    if (!contact) return;
    if (!contact._count.caseStudies) {
      await db.$transaction((tx) => addWork(tx, orgId, contact.id, SAMPLE_WORK));
    }
    if (!contact.resumeFileId) {
      await seedDemoResumes(orgId, [{ email, ...SAMPLE_RESUME }]);
    }
  } catch (error) {
    console.error('[sample] presentation work', error);
  }
}
