import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type Origin, type Stage, type StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { DEFAULT_TEMPLATES } from '@/server/email';
import { DEFAULT_STAGES, DEFAULT_ARCHIVE_REASONS } from '@/server/org-defaults';
import { demoResumesSeeded, seedDemoResumes, type DemoResume } from '@/server/demo-resume';
import { criteriaSeededWhere, seedMatchCriteria, seedSampleHighlights } from '@/server/demo-criteria';
import { DEMO_SCREEN_TITLE, seedTranscriptInsights } from '@/server/demo-insights';
import { demoWorkSeeded, seedDemoWork } from '@/server/demo-work';
import { seedHrDemo } from '@/server/hr-demo';

/**
 * Demo mode — a one-click "Explore the demo" login, gated behind DEMO_MODE.
 *
 * This is NOT an auth bypass: the button seeds an isolated demo org and signs
 * in through the normal credentials flow. The demo user's password is rotated
 * to a fresh random value on every demo login, so no static credential exists
 * to leak. Flip DEMO_MODE off and the button disappears.
 */

export const DEMO_EMAIL = 'demo@source.demo';

export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === '1' || process.env.NODE_ENV === 'development';
}

/**
 * Ensure the demo org + sample data exist, rotate the demo user's password,
 * and return credentials for an immediate signIn.
 */
export async function ensureDemoOrg(): Promise<{ email: string; password: string }> {
  const password = randomBytes(24).toString('base64url');
  // Cost 4, not 12: bcrypt's work factor protects guessable human passwords.
  // This one is 192 random bits, rotated on every demo login, so extra rounds
  // only added ~800ms to sign-in (hash here, then compare in authorize()).
  const passwordHash = await bcrypt.hash(password, 4);

  const existing = await db.user.findFirst({ where: { email: DEMO_EMAIL } });
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { passwordHash } });
    // Demo orgs seeded before the multi-role sample existed get it now. It's
    // sample data, so a failure here must not block signing in.
    const sampled = await db.posting.findUnique({
      where: { orgId_slug: { orgId: existing.orgId, slug: MULTI_ROLE_SLUG } },
      select: { id: true },
    });
    if (!sampled) {
      try {
        await db.$transaction((tx) => seedMultiRoleSample(tx, existing.orgId, existing.id));
      } catch (error) {
        console.error('[demo] multi-role sample', error);
      }
    }
    // Same for the filled-out profiles; their evaluations mark them done.
    const profiled = await db.aiEvaluation.findFirst({
      where: { orgId: existing.orgId, model: SAMPLE_MODEL },
      select: { id: true },
    });
    if (!profiled) {
      try {
        await db.$transaction((tx) => seedFullProfiles(tx, existing.orgId));
      } catch (error) {
        console.error('[demo] full profiles', error);
      }
    }
    // …and the recruiters on each role, and those four people's history.
    const [ownersSet, historied] = await Promise.all([
      db.posting.findFirst({ where: { orgId: existing.orgId, ownerId: { not: null } }, select: { id: true } }),
      db.interview.findFirst({ where: { orgId: existing.orgId, title: HISTORY_MARKER }, select: { id: true } }),
    ]);
    if (!ownersSet || !historied) {
      try {
        await db.$transaction(
          async (tx) => {
            if (!ownersSet) await seedRoleOwners(tx, existing.orgId, existing.id);
            if (!historied) await seedProfileHistory(tx, existing.orgId, existing.id);
          },
          { timeout: 20_000 },
        );
      } catch (error) {
        console.error('[demo] owners and history', error);
      }
    }
    // …and the roles' match criteria, with the samples scored against them.
    if (!(await db.posting.findFirst({ where: criteriaSeededWhere(existing.orgId), select: { id: true } }))) {
      try {
        await db.$transaction((tx) => seedMatchCriteria(tx, existing.orgId, SAMPLE_MODEL));
      } catch (error) {
        console.error('[demo] match criteria', error);
      }
    }
    // …and the questions pulled out of its interview transcripts.
    if (!(await db.transcript.findFirst({ where: { orgId: existing.orgId, title: DEMO_SCREEN_TITLE }, select: { id: true } }))) {
      try {
        await db.$transaction((tx) => seedTranscriptInsights(tx, existing.orgId), { timeout: 20_000 });
      } catch (error) {
        console.error('[demo] transcript insights', error);
      }
    }
    // …and the sample evaluations' career highlights.
    const unhighlighted = await db.aiEvaluation.findFirst({
      where: { orgId: existing.orgId, model: SAMPLE_MODEL, highlights: { equals: Prisma.DbNull } },
      select: { id: true },
    });
    if (unhighlighted) {
      try {
        await db.$transaction((tx) => seedSampleHighlights(tx, existing.orgId, SAMPLE_MODEL));
      } catch (error) {
        console.error('[demo] highlights', error);
      }
    }
    // …and their work, for the presentations.
    if (!(await demoWorkSeeded(existing.orgId))) {
      try {
        await db.$transaction((tx) => seedDemoWork(tx, existing.orgId));
      } catch (error) {
        console.error('[demo] case studies', error);
      }
    }
    await seedResumes(existing.orgId);
    await seedHr(existing.orgId);
    return { email: DEMO_EMAIL, password };
  }

  const orgId = await db.$transaction(async (tx) => {
    const slugTaken = await tx.organization.findUnique({ where: { slug: 'demo' } });
    const slug = slugTaken ? `demo-${Math.random().toString(36).slice(2, 7)}` : 'demo';
    // onboardedAt set up front — the demo drops you straight onto the board.
    const org = await tx.organization.create({
      data: { name: 'Demo Co', slug, onboardedAt: new Date() },
    });
    const user = await tx.user.create({
      data: {
        orgId: org.id,
        email: DEMO_EMAIL,
        name: 'Demo Recruiter',
        passwordHash,
        accessRole: 'SUPER_ADMIN',
      },
    });
    const referrer = await tx.user.create({
      data: {
        orgId: org.id,
        email: 'riley@source.demo',
        name: 'Riley Chen',
        passwordHash: null, // seeded teammate only; nobody signs in as Riley
        accessRole: 'TEAM_MEMBER',
      },
    });

    await tx.stage.createMany({ data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: org.id })) });
    await tx.archiveReason.createMany({
      data: DEFAULT_ARCHIVE_REASONS.map((r) => ({ ...r, orgId: org.id })),
    });
    const [confirmTpl, , interviewTpl] = await Promise.all(
      DEFAULT_TEMPLATES.map((t) => tx.emailTemplate.create({ data: { ...t, orgId: org.id } })),
    );
    await tx.organization.update({
      where: { id: org.id },
      data: {
        autoConfirmTemplateId: confirmTpl.id,
        autoInterviewTemplateId: interviewTpl.id,
      },
    });

    const stages = await tx.stage.findMany({ where: { orgId: org.id }, orderBy: { order: 'asc' } });
    // By type, not position: the defaults open with lead stages.
    const firstOf = (type: StageType) => stages.find((s) => s.type === type)!;
    const [applicant, screen, onsite, offer] = (['APPLICANT', 'SCREEN', 'ONSITE', 'OFFER'] as const).map(firstOf);

    const design = await tx.department.create({ data: { orgId: org.id, name: 'Design' } });
    const engineering = await tx.department.create({
      data: { orgId: org.id, name: 'Engineering' },
    });

    const designer = await tx.posting.create({
      data: {
        orgId: org.id,
        departmentId: design.id,
        slug: 'senior-product-designer',
        title: 'Senior Product Designer',
        state: 'PUBLISHED',
        location: 'Remote — US',
        workplaceType: 'REMOTE',
        commitment: 'FULL_TIME',
        salaryMin: 150000,
        salaryMax: 185000,
        salaryCurrency: 'USD',
        tags: ['design', 'product'],
        content: {
          description:
            'We are looking for a senior product designer to own end-to-end flows across our hiring platform — from pipeline views to candidate profiles. You will partner directly with engineering and talk to customers weekly.',
        },
      },
    });
    const engineer = await tx.posting.create({
      data: {
        orgId: org.id,
        departmentId: engineering.id,
        slug: 'founding-engineer',
        title: 'Founding Engineer',
        state: 'PUBLISHED',
        location: 'San Francisco, CA',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        salaryMin: 170000,
        salaryMax: 220000,
        salaryCurrency: 'USD',
        tags: ['engineering', 'typescript'],
        content: {
          description:
            'Early engineer across the whole stack: Next.js, Prisma, Postgres. You will ship features end to end and shape how the product is built.',
        },
      },
    });

    await tx.interviewPlanStep.createMany({
      data: [
        {
          orgId: org.id,
          postingId: designer.id,
          title: 'Portfolio review',
          durationMins: 60,
          focusAreas: ['Craft & visual quality', 'Storytelling', 'Design process'],
          order: 0,
        },
        {
          orgId: org.id,
          postingId: designer.id,
          title: 'Product thinking',
          durationMins: 45,
          focusAreas: ['Problem framing', 'Trade-offs', 'Metrics awareness'],
          order: 1,
        },
        {
          orgId: org.id,
          postingId: designer.id,
          title: 'Team fit',
          durationMins: 30,
          focusAreas: ['Collaboration', 'Feedback culture'],
          order: 2,
        },
      ],
    });

    const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

    async function candidate(input: {
      name: string;
      headline: string;
      location: string;
      email: string;
      tags?: string[];
      resumeText?: string;
      postingId: string;
      stageId: string;
      origin: 'APPLIED' | 'SOURCED' | 'REFERRED';
      inStageDays: number;
    }) {
      const contact = await tx.contact.create({
        data: {
          orgId: org.id,
          name: input.name,
          headline: input.headline,
          location: input.location,
          emails: [input.email],
          tags: input.tags ?? [],
          resumeText: input.resumeText,
        },
      });
      return seedApplication(tx, {
        orgId: org.id,
        ownerId: user.id,
        contactId: contact.id,
        postingId: input.postingId,
        stages,
        stageId: input.stageId,
        origin: input.origin,
        inStageDays: input.inStageDays,
      });
    }

    const maya = await candidate({
      name: 'Maya Chen',
      headline: 'Product Designer at Figment',
      location: 'Brooklyn, NY',
      email: 'maya.chen@example.com',
      tags: ['design-systems'],
      resumeText:
        'Product designer with 7 years across B2B SaaS. Built and maintained a design system used by 40 engineers. Led redesign of onboarding that lifted activation 18%. Tools: Figma, prototyping in code (React, Tailwind).',
      postingId: designer.id,
      stageId: screen.id,
      origin: 'SOURCED',
      inStageDays: 2,
    });
    const jordan = await candidate({
      name: 'Jordan Alvarez',
      headline: 'Senior Designer at Northbeam',
      location: 'Austin, TX',
      email: 'jordan.alvarez@example.com',
      resumeText:
        'Senior product designer specializing in complex data-heavy interfaces: dashboards, pipelines, reporting. Previously design lead on an ATS product. Strong systems thinker, comfortable in ambiguity.',
      postingId: designer.id,
      stageId: onsite.id,
      origin: 'REFERRED',
      inStageDays: 4,
    });
    const sam = await candidate({
      name: 'Sam Whitfield',
      headline: 'Staff Engineer at Relay',
      location: 'San Francisco, CA',
      email: 'sam.whitfield@example.com',
      tags: ['typescript', 'infra'],
      resumeText:
        'Full-stack engineer: TypeScript, Next.js, Postgres, Prisma. Scaled a marketplace from 10k to 2M users. Enjoys owning products end to end and mentoring.',
      postingId: engineer.id,
      stageId: offer.id,
      origin: 'SOURCED',
      inStageDays: 1,
    });
    await candidate({
      name: 'Priya Nair',
      headline: 'Design Lead at Meridian Health',
      location: 'Chicago, IL',
      email: 'priya.nair@example.com',
      postingId: designer.id,
      stageId: applicant.id,
      origin: 'APPLIED',
      inStageDays: 1,
    });
    await candidate({
      name: 'Diego Ramos',
      headline: 'Software Engineer at Lattice',
      location: 'Denver, CO',
      email: 'diego.ramos@example.com',
      postingId: engineer.id,
      stageId: screen.id,
      origin: 'APPLIED',
      inStageDays: 9, // trips the SLA highlight on the board
    });
    await candidate({
      name: 'Alex Kim',
      headline: 'Frontend Engineer at Parcel',
      location: 'Seattle, WA',
      email: 'alex.kim@example.com',
      postingId: engineer.id,
      stageId: applicant.id,
      origin: 'APPLIED',
      inStageDays: 3,
    });

    // A completed interview with a transcript (feeds Ask AI + the kit page)…
    const completed = await tx.interview.create({
      data: {
        org: { connect: { id: org.id } },
        opportunity: { connect: { id: jordan.id } },
        title: 'Portfolio review',
        startAt: daysAgo(3),
        durationMins: 60,
        focusAreas: ['Craft & visual quality', 'Storytelling', 'Design process'],
        state: 'COMPLETED',
        panelists: { connect: { id: user.id } },
      },
    });
    await tx.transcript.create({
      data: {
        orgId: org.id,
        opportunityId: jordan.id,
        interviewId: completed.id,
        title: 'Portfolio review — Jordan Alvarez',
        source: 'manual',
        content: [
          'Interviewer: Thanks for walking us through your work. Can you start with the pipeline redesign?',
          'Jordan: Sure. The core problem was that recruiters lost track of candidates once volume passed a few hundred. I redesigned the board around stage aging — anything sitting more than a week gets surfaced automatically.',
          'Interviewer: How did you validate that?',
          'Jordan: We ran it with five recruiting teams for a month. Time-to-first-touch dropped about 30%, and the qualitative feedback was that the board finally matched how they triaged in their heads.',
          'Interviewer: What was the hardest trade-off?',
          'Jordan: Density versus scannability. Recruiters wanted every field on the card; we cut it to name, role, and days-in-stage, and moved everything else to hover. That fight took three rounds of testing.',
          'Interviewer: You mentioned you built the design system there too?',
          'Jordan: Yes — tokens, a component library in Figma mirrored in React, and a review process so engineers could propose components. It cut design QA time roughly in half.',
          'Interviewer: Anything you would do differently?',
          'Jordan: I would involve data earlier. We designed the reporting views last, and retrofitting metrics into the flows was painful. Reporting should have been a first-class object from day one.',
        ].join('\n'),
      },
    });
    await tx.feedbackSubmission.create({
      data: {
        orgId: org.id,
        opportunityId: jordan.id,
        interviewId: completed.id,
        authorId: user.id,
        overallRating: 4,
        summary:
          'Strong systems thinker with directly relevant ATS experience. Clear storytelling, honest about trade-offs. Advance to team fit.',
      },
    });

    // …and an upcoming one so the interviews list has a future row.
    await tx.interview.create({
      data: {
        org: { connect: { id: org.id } },
        opportunity: { connect: { id: maya.id } },
        title: 'Phone screen',
        startAt: daysFromNow(2),
        durationMins: 30,
        location: 'https://meet.example.com/demo',
        state: 'SCHEDULED',
        panelists: { connect: { id: user.id } },
      },
    });

    await tx.note.create({
      data: {
        orgId: org.id,
        opportunityId: jordan.id,
        authorId: user.id,
        body: 'Referred by our former design lead — she worked with Jordan for two years and vouches strongly. Prioritize scheduling.',
      },
    });
    await tx.task.create({
      data: {
        orgId: org.id,
        opportunityId: jordan.id,
        assigneeId: user.id,
        creatorId: user.id,
        title: 'Send team-fit prep materials to Jordan',
        dueAt: daysFromNow(2),
      },
    });
    await tx.offer.create({
      data: {
        orgId: org.id,
        opportunityId: sam.id,
        status: 'SENT',
        jobTitle: 'Founding Engineer',
        salaryAmount: 195000,
        salaryCurrency: 'USD',
        equity: '0.8%',
        startDate: daysFromNow(30),
        expiresAt: daysFromNow(7),
        createdById: user.id,
        sentAt: daysAgo(1),
      },
    });

    const pendingPosting = await tx.posting.create({
      data: {
        orgId: org.id,
        departmentId: design.id,
        slug: 'head-of-people',
        title: 'Head of People',
        state: 'PENDING_APPROVAL',
        location: 'Remote — US',
        workplaceType: 'REMOTE',
        commitment: 'FULL_TIME',
        content: {
          description: 'Own recruiting ops, culture, and the people stack as we scale past 50.',
        },
      },
    });
    await tx.approvalRequest.create({
      data: {
        orgId: org.id,
        subjectType: 'POSTING',
        subjectId: pendingPosting.id,
        title: pendingPosting.title,
        href: `/postings/${pendingPosting.id}`,
        requestedById: referrer.id,
      },
    });

    await tx.referral.create({
      data: {
        orgId: org.id,
        referringUserId: referrer.id,
        contactId: jordan.contactId,
        opportunityId: jordan.id,
        postingId: designer.id,
        relationship: 'worked-together',
        notes: 'Worked together at Northbeam for two years. Strong systems thinker, already ATS-fluent.',
      },
    });

    await seedMultiRoleSample(tx, org.id, user.id);
    await seedFullProfiles(tx, org.id);
    await seedMatchCriteria(tx, org.id, SAMPLE_MODEL);
    await seedSampleHighlights(tx, org.id, SAMPLE_MODEL);
    await seedRoleOwners(tx, org.id, user.id);
    await seedProfileHistory(tx, org.id, user.id);
    await seedTranscriptInsights(tx, org.id);
    await seedDemoWork(tx, org.id);

    await tx.event.create({
      data: {
        orgId: org.id,
        actorType: 'system',
        actorId: 'demo-seed',
        verb: 'org.created',
        subjectType: 'organization',
        subjectId: org.id,
        payload: { name: 'Demo Co', slug, demo: true },
      },
    });
    return org.id;
  });

  await seedResumes(orgId);
  await seedHr(orgId);
  return { email: DEMO_EMAIL, password };
}

/** Leave types, attendance and leave requests for the demo; never blocks signing in. */
async function seedHr(orgId: string) {
  try {
    await seedHrDemo(orgId);
  } catch (error) {
    console.error('[demo] hr', error);
  }
}

/** Resume files and their parsed profiles for the filled-out candidates; never blocks signing in. */
async function seedResumes(orgId: string) {
  try {
    if (await demoResumesSeeded(orgId, FULL_PROFILES.map((p) => p.email))) return;
    await seedDemoResumes(
      orgId,
      FULL_PROFILES.map((p) => ({ email: p.email, resume: p.resume, parsed: p.parsed })),
    );
  } catch (error) {
    console.error('[demo] resumes', error);
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
/** The multi-role sample's posting; its presence means the sample is seeded. */
const MULTI_ROLE_SLUG = 'design-engineer';

/**
 * Open one application in the demo and walk its stage history, so
 * pass-through and time-in-stage analytics see the seeded pipeline
 * (transitions are normally written on every move).
 */
async function seedApplication(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    ownerId: string;
    contactId: string;
    postingId: string;
    stages: Stage[];
    stageId: string;
    origin: Origin;
    inStageDays: number;
    archiveReasonId?: string;
  },
) {
  const opportunity = await tx.opportunity.create({
    data: {
      orgId: input.orgId,
      contactId: input.contactId,
      postingId: input.postingId,
      stageId: input.stageId,
      origin: input.origin,
      ownerId: input.ownerId,
      stageChangedAt: daysAgo(input.inStageDays),
      createdAt: daysAgo(input.inStageDays + 6),
      ...(input.archiveReasonId
        ? { status: 'ARCHIVED', archiveReasonId: input.archiveReasonId, archivedAt: daysAgo(input.inStageDays) }
        : {}),
    },
  });
  const target = input.stages.find((x) => x.id === input.stageId)!;
  const path = input.stages.filter((s) => s.order <= target.order);
  let at = daysAgo(input.inStageDays + 6);
  for (const [i, s] of path.entries()) {
    await tx.stageTransition.create({
      data: {
        opportunityId: opportunity.id,
        fromStageId: i === 0 ? null : path[i - 1].id,
        toStageId: s.id,
        actorId: input.ownerId,
        occurredAt: at,
      },
    });
    at = new Date(at.getTime() + ((6 * 24 * 60 * 60 * 1000) / Math.max(path.length, 1)) * 0.9);
  }
  return opportunity;
}

/**
 * One person, several roles: a Design Engineer posting that two existing
 * demo candidates also applied to. Maya has two open applications; Alex has
 * two open ones and an earlier one that was archived. Keyed on the
 * posting's slug, so it runs once per demo org, and it skips anyone the
 * shared demo has since deleted.
 */
async function seedMultiRoleSample(tx: Prisma.TransactionClient, orgId: string, ownerId: string) {
  const exists = await tx.posting.findUnique({
    where: { orgId_slug: { orgId, slug: MULTI_ROLE_SLUG } },
    select: { id: true },
  });
  if (exists) return;

  const [stages, design, designer, maya, alex, underqualified] = await Promise.all([
    tx.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } }),
    tx.department.findFirst({ where: { orgId, name: 'Design' }, select: { id: true } }),
    tx.posting.findUnique({
      where: { orgId_slug: { orgId, slug: 'senior-product-designer' } },
      select: { id: true },
    }),
    tx.contact.findFirst({ where: { orgId, emails: { has: 'maya.chen@example.com' } }, select: { id: true } }),
    tx.contact.findFirst({ where: { orgId, emails: { has: 'alex.kim@example.com' } }, select: { id: true } }),
    tx.archiveReason.findFirst({ where: { orgId, name: 'Underqualified' }, select: { id: true } }),
  ]);
  const applicant = stages.find((s) => s.type === 'APPLICANT');
  const screen = stages.find((s) => s.type === 'SCREEN');
  if (!applicant || !screen) return;

  const designEngineer = await tx.posting.create({
    data: {
      orgId,
      departmentId: design?.id,
      slug: MULTI_ROLE_SLUG,
      title: 'Design Engineer',
      state: 'PUBLISHED',
      location: 'Remote — US',
      workplaceType: 'REMOTE',
      commitment: 'FULL_TIME',
      salaryMin: 160000,
      salaryMax: 200000,
      salaryCurrency: 'USD',
      tags: ['design', 'engineering', 'react'],
      content: {
        description:
          'Half designer, half frontend engineer. You will prototype in code, build our component library, and take interfaces from Figma to production.',
      },
    },
  });

  const base = { orgId, ownerId, postingId: designEngineer.id, stages };
  if (maya) {
    await seedApplication(tx, {
      ...base,
      contactId: maya.id,
      stageId: applicant.id,
      origin: 'APPLIED',
      inStageDays: 1,
    });
  }
  if (alex) {
    await seedApplication(tx, {
      ...base,
      contactId: alex.id,
      stageId: screen.id,
      origin: 'APPLIED',
      inStageDays: 2,
    });
    // An earlier try at the senior design role, archived before this round.
    if (designer && underqualified) {
      await seedApplication(tx, {
        ...base,
        postingId: designer.id,
        contactId: alex.id,
        stageId: screen.id,
        origin: 'APPLIED',
        inStageDays: 40,
        archiveReasonId: underqualified.id,
      });
    }
  }
}

/** Marks the sample evaluations below; also what the profile shows as their source. */
const SAMPLE_MODEL = 'Sample';

/**
 * Four candidates with everything filled in (phone, links, a full
 * background, and an evaluation for the Spotlight), so their profiles and
 * presentations look finished. Only contacts still as seeded are touched:
 * no phone and no links yet. The shared demo may have edited the rest.
 */
const FULL_PROFILES: {
  email: string;
  posting: string;
  phone: string;
  links: string[];
  resume: string;
  /** What resume parsing would have read from `resume` (demo-resume.ts). */
  parsed: DemoResume['parsed'];
  evaluation: { recommendation: number; summary: string; strengths: string[]; concerns: string[]; questions: string[] };
}[] = [
  {
    email: 'maya.chen@example.com',
    posting: 'senior-product-designer',
    phone: '+1 (718) 555-0142',
    links: ['https://www.linkedin.com/in/maya-chen-demo', 'https://dribbble.com/mayachen-demo'],
    resume: [
      'Product designer with 7 years in B2B SaaS. At Figment I lead design for the collaboration surfaces used by 40,000 teams, and I care most about the unglamorous middle of a product: settings, permissions, and the flows people repeat every day.',
      '',
      'Figment — Senior Product Designer, Brooklyn, NY, Mar 2022–now. Built and maintain the design system 40 engineers ship from. Led the onboarding redesign that lifted activation 18%. Run a monthly design review open to the whole company.',
      '',
      'Lumen Analytics — Product Designer, New York, NY, Jun 2019–Feb 2022. Designed the reporting suite from zero to 300 paying customers. Ran weekly customer interviews and turned them into a shared research library.',
      '',
      'Studio Nine — Designer, New York, NY, Aug 2017–May 2019. Brand and product work for early-stage startups.',
      '',
      'Tools: Figma, prototyping in code (React, Tailwind), Maze. BFA in Communication Design, Pratt Institute, 2013–2017.',
    ].join('\n'),
    parsed: {
      summary:
        'Product designer with 7 years in B2B SaaS. At Figment I lead design for the collaboration surfaces used by 40,000 teams, and I care most about the unglamorous middle of a product: settings, permissions, and the flows people repeat every day.',
      skills: ['Figma', 'Design systems', 'Prototyping', 'React', 'Tailwind CSS', 'Maze', 'User research', 'Onboarding', 'Information architecture'],
      experience: [
        { title: 'Senior Product Designer', company: 'Figment', location: 'Brooklyn, NY', start: '2022-03', end: 'present' },
        { title: 'Product Designer', company: 'Lumen Analytics', location: 'New York, NY', start: '2019-06', end: '2022-02' },
        { title: 'Designer', company: 'Studio Nine', location: 'New York, NY', start: '2017-08', end: '2019-05' },
      ],
      education: [{ school: 'Pratt Institute', degree: 'BFA', field: 'Communication Design', start: '2013', end: '2017' }],
    },
    evaluation: {
      recommendation: 4,
      summary:
        'A systems-minded product designer whose design-system and onboarding work map straight onto this role, with measured outcomes to show for both.',
      strengths: ['Design systems at scale', 'Onboarding that moved activation', 'Prototypes in code', 'Steady research habit'],
      concerns: ['Less time in dense, data-heavy workflows like a recruiting pipeline'],
      questions: [
        'Walk us through a design-system decision you later reversed.',
        'How did you isolate the 18% activation lift from everything else shipping that quarter?',
      ],
    },
  },
  {
    email: 'jordan.alvarez@example.com',
    posting: 'senior-product-designer',
    phone: '+1 (512) 555-0187',
    links: ['https://www.linkedin.com/in/jordan-alvarez-demo', 'https://www.behance.net/jordanalvarez-demo'],
    resume: [
      'Senior product designer for data-heavy tools: dashboards, pipelines, and reporting. I like the moment a crowded screen finally matches how people already think about their work.',
      '',
      'Northbeam — Senior Designer, Austin, TX, Apr 2021–now. Redesigned attribution reporting for 2,000 marketing teams; cut time-to-first-insight from days to minutes.',
      '',
      'Hireloop — Design Lead, Austin, TX, Jul 2019–Mar 2021; Senior Product Designer, Jan 2018–Jun 2019. Led design for an applicant tracking system: the pipeline board, stage aging, and recruiter reporting. Time-to-first-touch dropped about 30% after the board redesign.',
      '',
      'Freelance — Product Designer, remote, 2016–2017. Internal tools for logistics and fintech clients.',
      '',
      'Built a token-based design system mirrored in Figma and React. BA in Human-Computer Interaction, UT Austin, 2012–2016.',
    ].join('\n'),
    parsed: {
      summary:
        'Senior product designer for data-heavy tools: dashboards, pipelines, and reporting. I like the moment a crowded screen finally matches how people already think about their work.',
      skills: ['Figma', 'Data visualization', 'Dashboards', 'Design systems', 'Design tokens', 'React', 'User research', 'Reporting'],
      experience: [
        { title: 'Senior Designer', company: 'Northbeam', location: 'Austin, TX', start: '2021-04', end: 'present' },
        { title: 'Design Lead', company: 'Hireloop', location: 'Austin, TX', start: '2019-07', end: '2021-03' },
        { title: 'Senior Product Designer', company: 'Hireloop', location: 'Austin, TX', start: '2018-01', end: '2019-06' },
        { title: 'Product Designer', company: 'Freelance', location: 'Remote', start: '2016', end: '2017' },
      ],
      education: [{ school: 'The University of Texas at Austin', degree: 'BA', field: 'Human-Computer Interaction', start: '2012', end: '2016' }],
    },
    evaluation: {
      recommendation: 4,
      summary:
        'Has designed an applicant tracking system before and pairs strong craft with a clear point of view on information density. Rare, directly relevant experience.',
      strengths: ['Designed an ATS pipeline before', 'Data-dense interfaces', 'Clear storytelling', 'Validates with customers'],
      concerns: ['Reporting came late in past projects; probe how they would sequence it here'],
      questions: [
        'What did recruiters push back on in the stage-aging board, and what did you keep anyway?',
        'How would you bring reporting in from day one?',
      ],
    },
  },
  {
    email: 'sam.whitfield@example.com',
    posting: 'founding-engineer',
    phone: '+1 (415) 555-0119',
    links: ['https://github.com/samwhitfield-demo', 'https://www.linkedin.com/in/sam-whitfield-demo'],
    resume: [
      'Full-stack engineer who likes owning a product end to end, from the schema to the empty state. TypeScript, Next.js, Postgres, and Prisma for the last six years.',
      '',
      'Relay — Staff Engineer, San Francisco, CA, Jan 2023–now; Senior Engineer, Feb 2021–Dec 2022. Scaled the marketplace from 10,000 to 2 million users. Led the move to a typed API layer and cut p95 page loads by 60%. Mentor four engineers.',
      '',
      'Parcelwise — Senior Engineer, Oakland, CA, Mar 2018–Jan 2021. Built the carrier-rates engine and the internal ops console. On call for payments.',
      '',
      'Tandem Labs — Software Engineer, San Francisco, CA, Jul 2016–Feb 2018. Frontend for a B2B scheduling product.',
      '',
      'Open source: maintainer of a small Prisma extension for soft deletes. BS in Computer Science, UC Davis, 2012–2016.',
    ].join('\n'),
    parsed: {
      summary:
        'Full-stack engineer who likes owning a product end to end, from the schema to the empty state. TypeScript, Next.js, Postgres, and Prisma for the last six years.',
      skills: ['TypeScript', 'Next.js', 'React', 'Node.js', 'PostgreSQL', 'Prisma', 'API design', 'Performance', 'Payments', 'Mentoring'],
      experience: [
        { title: 'Staff Engineer', company: 'Relay', location: 'San Francisco, CA', start: '2023-01', end: 'present' },
        { title: 'Senior Engineer', company: 'Relay', location: 'San Francisco, CA', start: '2021-02', end: '2022-12' },
        { title: 'Senior Engineer', company: 'Parcelwise', location: 'Oakland, CA', start: '2018-03', end: '2021-01' },
        { title: 'Software Engineer', company: 'Tandem Labs', location: 'San Francisco, CA', start: '2016-07', end: '2018-02' },
      ],
      education: [{ school: 'University of California, Davis', degree: 'BS', field: 'Computer Science', start: '2012', end: '2016' }],
    },
    evaluation: {
      recommendation: 4,
      summary:
        'A proven early-stage builder on exactly this stack, with scale experience and a habit of mentoring. Strong founding-engineer profile.',
      strengths: ['Next.js, Prisma, Postgres in production', 'Scaled a product 200×', 'Owns work end to end', 'Mentors'],
      concerns: ['Most recent role is at a larger company; check appetite for ambiguity'],
      questions: [
        'What would you build first here, and what would you deliberately not build?',
        'Tell us about the typed API migration: what broke, and how did you roll it out?',
      ],
    },
  },
  {
    email: 'priya.nair@example.com',
    posting: 'senior-product-designer',
    phone: '+1 (312) 555-0164',
    links: ['https://www.linkedin.com/in/priya-nair-demo', 'https://dribbble.com/priyanair-demo'],
    resume: [
      'Design lead in healthcare software. I have spent eight years making clinical tools calmer and more accessible, and I lead a team of five designers.',
      '',
      'Meridian Health — Design Lead, Chicago, IL, Apr 2022–now; Senior Product Designer, Jan 2020–Mar 2022. Leads design for the patient intake and scheduling products used in 300 clinics. Brought the product to WCAG 2.2 AA and set up the accessibility review every release goes through.',
      '',
      'CarePath — Senior Product Designer, Chicago, IL, May 2017–Dec 2019. Designed the care-team messaging product from first sketch to launch.',
      '',
      'Fieldnote Studio — Interaction Designer, Chicago, IL, Jun 2015–Apr 2017. Health and public-sector projects.',
      '',
      'MDes in Interaction Design, IIT Institute of Design, 2013–2015.',
    ].join('\n'),
    parsed: {
      summary:
        'Design lead in healthcare software. I have spent eight years making clinical tools calmer and more accessible, and I lead a team of five designers.',
      skills: ['Accessibility (WCAG 2.2)', 'Design leadership', 'Healthcare UX', 'Service design', 'User research', 'Figma', 'Design systems'],
      experience: [
        { title: 'Design Lead', company: 'Meridian Health', location: 'Chicago, IL', start: '2022-04', end: 'present' },
        { title: 'Senior Product Designer', company: 'Meridian Health', location: 'Chicago, IL', start: '2020-01', end: '2022-03' },
        { title: 'Senior Product Designer', company: 'CarePath', location: 'Chicago, IL', start: '2017-05', end: '2019-12' },
        { title: 'Interaction Designer', company: 'Fieldnote Studio', location: 'Chicago, IL', start: '2015-06', end: '2017-04' },
      ],
      education: [{ school: 'IIT Institute of Design', degree: 'MDes', field: 'Interaction Design', start: '2013', end: '2015' }],
    },
    evaluation: {
      recommendation: 3,
      summary:
        'A strong design leader with deep accessibility practice. Her management experience goes beyond this role, so the question is appetite for hands-on IC work.',
      strengths: ['Accessibility leadership', 'Leads a team of five', 'Complex regulated workflows', 'Research-led'],
      concerns: ['May want a management track; this role is hands-on', 'No B2B recruiting-domain experience'],
      questions: [
        'What would you miss about managing, and what would you not?',
        'How would you run accessibility reviews on a small team without slowing shipping?',
      ],
    },
  },
];

async function seedFullProfiles(tx: Prisma.TransactionClient, orgId: string) {
  for (const p of FULL_PROFILES) {
    const contact = await tx.contact.findFirst({
      where: { orgId, emails: { has: p.email } },
      select: { id: true, phones: true, links: true },
    });
    // Seeded contacts hold NULL here, not [] (so no isEmpty filter): treat both as untouched.
    if (!contact || contact.phones?.length || contact.links?.length) continue;
    await tx.contact.update({
      where: { id: contact.id },
      data: { phones: [p.phone], links: p.links, resumeText: p.resume },
    });
    const opportunity = await tx.opportunity.findFirst({
      where: { orgId, contactId: contact.id, posting: { slug: p.posting } },
      select: { id: true },
    });
    if (opportunity) {
      await tx.aiEvaluation.create({
        data: { orgId, opportunityId: opportunity.id, model: SAMPLE_MODEL, ...p.evaluation },
      });
    }
  }
}

/**
 * A recruiter on every demo role: the demo user runs the two original
 * roles, Riley the Design Engineer and Head of People searches, so Maya's
 * Design Engineer application shows a candidate owned by someone other
 * than the role's recruiter. Only fills roles with no owner yet.
 */
async function seedRoleOwners(tx: Prisma.TransactionClient, orgId: string, demoUserId: string) {
  const riley = await tx.user.findFirst({ where: { orgId, email: 'riley@source.demo' }, select: { id: true } });
  const plan: [string, string | undefined][] = [
    ['senior-product-designer', demoUserId],
    ['founding-engineer', demoUserId],
    ['design-engineer', riley?.id ?? demoUserId],
    ['head-of-people', riley?.id ?? demoUserId],
  ];
  for (const [slug, ownerId] of plan) {
    await tx.posting.updateMany({ where: { orgId, slug, ownerId: null }, data: { ownerId } });
  }
}

const daysAhead = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const at = (days: number, hour: number) => {
  const d = days >= 0 ? daysAhead(days) : daysAgo(-days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** An interview only the history seed creates; its presence means the history is in. */
const HISTORY_MARKER = 'System design';

type HistoryInterview = {
  title: string;
  day: number; // relative to today; negative is past
  hour: number;
  mins: number;
  focus: string[];
  feedback?: { rating: number; summary: string };
  transcript?: string[];
};
type History = {
  email: string;
  posting: string;
  notes: { day: number; body: string }[];
  emails: { day: number; subject: string; body: string; automated?: boolean }[];
  interviews: HistoryInterview[];
  tasks: { title: string; due: number; done?: boolean }[];
};

/**
 * The rest of the four filled-out candidates' profiles (interviews with
 * feedback and a transcript, notes, sent email, tasks) and the activity
 * that goes with it, dated around where each sits in the pipeline. Jordan
 * came seeded with a portfolio review, a note, and a task, so his adds the
 * emails and his next interview. Skips anyone whose application already
 * has email, so it never doubles up.
 */
const HISTORY: History[] = [
  {
    email: 'maya.chen@example.com',
    posting: 'senior-product-designer',
    notes: [
      {
        day: -7,
        body: 'Sourced from her talk on the Figment design system. Strongest systems thinker in this search so far. Probe how she handles dense, data-heavy screens; most of her work is collaboration UI.',
      },
      { day: -3, body: 'Replied within the hour and asked good questions about the team. Phone screen booked for later this week.' },
    ],
    emails: [
      {
        day: -7,
        subject: 'Senior Product Designer at Demo Co',
        body: 'Hi Maya,\n\nI came across your talk on the Figment design system and loved how you described getting forty engineers to ship from one source of truth. We’re hiring a senior product designer to own our pipeline and candidate views, and your work feels like a real fit.\n\nOpen to a 30-minute chat this week?\n\nBest,\nDemo Recruiter',
      },
      {
        day: -3,
        subject: 'Re: Senior Product Designer at Demo Co',
        body: 'Great to hear from you, Maya. I’ve booked the phone screen; you’ll get a calendar invite with the video link shortly. Looking forward to it.',
      },
    ],
    interviews: [],
    tasks: [
      { title: 'Prep portfolio-review questions for Maya', due: 3 },
      { title: 'Send Maya the role brief', due: -4, done: true },
    ],
  },
  {
    email: 'jordan.alvarez@example.com',
    posting: 'senior-product-designer',
    notes: [],
    emails: [
      {
        day: -5,
        subject: 'Portfolio review confirmed',
        body: 'Hi Jordan,\n\nYou’re confirmed for the portfolio review. Plan on 45 minutes walking us through two projects, then 15 for questions. We’d love to hear about the pipeline board you designed.\n\nSee you then,\nDemo Recruiter',
      },
      {
        day: -1,
        subject: 'Next step: team fit',
        body: 'Jordan, the team loved your portfolio review. The last step is a 30-minute team-fit conversation; I’ve sent a few times for this week. Prep notes are on their way.',
      },
    ],
    interviews: [{ title: 'Team fit', day: 3, hour: 14, mins: 30, focus: ['Collaboration', 'Feedback culture'] }],
    tasks: [],
  },
  {
    email: 'sam.whitfield@example.com',
    posting: 'founding-engineer',
    notes: [
      {
        day: -4,
        body: 'References came back glowing: two former managers at Relay called out ownership and mentoring. Offer approved at the top of the band.',
      },
      { day: -9, body: 'Excited about the stack and the stage. Mentioned one other late-stage process; move quickly.' },
    ],
    emails: [
      {
        day: -13,
        subject: 'Founding Engineer at Demo Co: next steps',
        body: 'Hi Sam,\n\nThanks for the great intro call. Next is a technical deep dive with our CTO, then a system-design session. I’ll send times for both today.\n\nDemo Recruiter',
      },
      {
        day: -1,
        subject: 'Your offer from Demo Co',
        body: 'Sam, we’re thrilled to offer you the Founding Engineer role. Your offer letter is attached; it’s open for a week, and I’m happy to walk through any of it.',
      },
    ],
    interviews: [
      {
        title: 'Technical deep dive',
        day: -11,
        hour: 11,
        mins: 60,
        focus: ['TypeScript depth', 'Data modelling', 'Debugging'],
        feedback: {
          rating: 4,
          summary:
            'Deep, practical TypeScript and Postgres knowledge. Walked through a painful migration with real humility. Strong yes.',
        },
      },
      {
        title: HISTORY_MARKER,
        day: -8,
        hour: 15,
        mins: 60,
        focus: ['Architecture', 'Trade-offs', 'Scaling'],
        feedback: {
          rating: 4,
          summary:
            'Designed the pipeline board end to end: sensible schema, clear read paths, and knew when not to add a cache. Strong yes.',
        },
        transcript: [
          'Interviewer: Let’s design the pipeline view for an ATS with a few hundred thousand candidates. Where do you start?',
          'Sam: With the reads. Recruiters live on this screen, so I’d model the stage counts and the list as the two hot queries and index for those first.',
          'Interviewer: Would you cache the counts?',
          'Sam: Not at first. A composite index on org, status and stage makes the count cheap. I’d measure before adding a cache, because invalidating it on every stage move is where bugs live.',
          'Interviewer: How do you keep the list fast as it grows?',
          'Sam: Keyset pagination on stage-changed time, not offsets. And I’d keep the row payload small: name, role, days in stage.',
          'Interviewer: What would you build first if you joined?',
          'Sam: The import path. Nobody switches ATS without their history, so I’d make that boring and reliable before anything clever.',
        ],
      },
      {
        title: 'Founder conversation',
        day: -6,
        hour: 10,
        mins: 45,
        focus: ['Motivation', 'Ownership'],
        feedback: {
          rating: 3,
          summary:
            'Clear motivation and good questions about the roadmap. Wants to own infrastructure decisions; worth aligning on that before day one. Yes.',
        },
      },
    ],
    tasks: [
      { title: 'Follow up with Sam on the offer', due: 2 },
      { title: 'Check Sam’s references', due: -5, done: true },
    ],
  },
  {
    email: 'priya.nair@example.com',
    posting: 'senior-product-designer',
    notes: [
      {
        day: -6,
        body: 'Applied through the careers site. Deep accessibility background and currently leads a team of five. Find out early whether she wants a hands-on IC role.',
      },
    ],
    emails: [
      {
        day: -7,
        subject: 'Thanks for applying to Senior Product Designer',
        body: 'Hi Priya,\n\nThanks for applying to the Senior Product Designer role at Demo Co. We’ve got your application and will be in touch within a week.\n\nThe Demo Co team',
        automated: true,
      },
    ],
    interviews: [],
    tasks: [{ title: 'Review Priya’s portfolio', due: 1 }],
  },
];

async function seedProfileHistory(tx: Prisma.TransactionClient, orgId: string, ownerId: string) {
  const owner = await tx.user.findUnique({ where: { id: ownerId }, select: { name: true } });
  for (const h of HISTORY) {
    const opportunity = await tx.opportunity.findFirst({
      where: { orgId, contact: { emails: { has: h.email } }, posting: { slug: h.posting } },
      select: { id: true, contactId: true, contact: { select: { name: true } } },
    });
    if (!opportunity) continue;
    if (await tx.emailMessage.findFirst({ where: { opportunityId: opportunity.id }, select: { id: true } })) continue;

    const subject = { subjectType: 'opportunity', subjectId: opportunity.id };
    const event = (verb: string, occurredAt: Date, payload: Record<string, unknown>, system = false) =>
      tx.event.create({
        data: {
          orgId,
          actorType: system ? 'system' : 'user',
          actorId: system ? null : ownerId,
          verb,
          ...subject,
          payload: payload as Prisma.InputJsonValue,
          occurredAt,
        },
      });

    for (const n of h.notes) {
      const when = at(n.day, 16);
      await tx.note.create({ data: { orgId, opportunityId: opportunity.id, authorId: ownerId, body: n.body, createdAt: when } });
      await event('note.added', when, {});
    }
    for (const e of h.emails) {
      const when = at(e.day, 9);
      await tx.emailMessage.create({
        data: {
          orgId,
          contactId: opportunity.contactId,
          opportunityId: opportunity.id,
          senderId: e.automated ? null : ownerId,
          toEmail: h.email,
          subject: e.subject,
          body: e.body,
          status: 'SENT',
          sentAt: when,
          createdAt: when,
        },
      });
      await event('email.sent', when, { subject: e.subject, to: h.email }, e.automated);
    }
    for (const iv of h.interviews) {
      const startAt = at(iv.day, iv.hour);
      const past = iv.day < 0;
      const interview = await tx.interview.create({
        data: {
          org: { connect: { id: orgId } },
          opportunity: { connect: { id: opportunity.id } },
          title: iv.title,
          startAt,
          durationMins: iv.mins,
          focusAreas: iv.focus,
          location: 'https://meet.example.com/demo',
          state: past ? 'COMPLETED' : 'SCHEDULED',
          panelists: { connect: { id: ownerId } },
        },
      });
      await event('interview.scheduled', daysAgo(Math.max(1, -iv.day + 3)), { title: iv.title, panel: [owner?.name ?? 'Demo Recruiter'] });
      if (past) await event('interview.completed', new Date(startAt.getTime() + iv.mins * 60_000), { title: iv.title });
      if (iv.feedback) {
        const when = new Date(startAt.getTime() + (iv.mins + 45) * 60_000);
        await tx.feedbackSubmission.create({
          data: {
            orgId,
            opportunityId: opportunity.id,
            interviewId: interview.id,
            authorId: ownerId,
            overallRating: iv.feedback.rating,
            summary: iv.feedback.summary,
            createdAt: when,
          },
        });
        await event('feedback.submitted', when, {
          contactName: opportunity.contact.name,
          rating: ['', 'Strong no', 'No', 'Yes', 'Strong yes'][iv.feedback.rating],
        });
      }
      if (iv.transcript) {
        await tx.transcript.create({
          data: {
            orgId,
            opportunityId: opportunity.id,
            interviewId: interview.id,
            title: `${iv.title} — ${opportunity.contact.name}`,
            source: 'manual',
            content: iv.transcript.join('\n'),
          },
        });
      }
    }
    for (const t of h.tasks) {
      const created = daysAgo(Math.max(1, -Math.min(t.due, 0) + 2));
      await tx.task.create({
        data: {
          orgId,
          opportunityId: opportunity.id,
          assigneeId: ownerId,
          creatorId: ownerId,
          title: t.title,
          dueAt: at(t.due, 17),
          completedAt: t.done ? at(t.due, 12) : null,
          createdAt: created,
        },
      });
      await event('task.created', created, { title: t.title });
      if (t.done) await event('task.completed', at(t.due, 12), { title: t.title });
    }
  }
}
