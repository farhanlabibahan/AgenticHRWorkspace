import { Prisma, type Commitment, type OrgKind, type WorkplaceType } from '@prisma/client';
import { db } from '@/lib/db';
import { DEFAULT_STAGES } from '@/server/org-defaults';
import { SAMPLE_BOARD_SLUGS, SAMPLE_PRESENTATION_CODE } from '@/lib/sample-links';
import { ensureSampleWork } from '@/server/demo-work';

export { SAMPLE_PRESENTATION_CODE };

/**
 * Sample job boards and a sample candidate presentation, linked from the
 * homepage so a visitor can open the real pages rather than a picture.
 *
 * Each is an organization with no users: nobody can sign in to change it,
 * unlike the shared demo workspace. It's created on the first visit to one
 * of its pages (ensureSample…), and it stays read-only everywhere a visitor
 * could act on it:
 *   - applying is off (the posting page says so; applyAction refuses);
 *   - the job-board feed leaves it out, so no aggregator lists a fake role;
 *   - its pages are noindex;
 *   - signup never hands out a `sample-` slug (workspace.ts).
 */

export const SAMPLE_SLUG_PREFIX = 'sample-';

/** A slug that belongs to the sample boards; a real workspace never gets one. */
export const isSampleSlug = (slug: string) => slug.startsWith(SAMPLE_SLUG_PREFIX);

type SamplePosting = {
  slug: string;
  title: string;
  group: string;
  location: string;
  workplaceType: WorkplaceType;
  commitment: Commitment;
  salary?: [number, number];
  description: string;
};

type SampleBoard = {
  slug: string;
  name: string;
  kind: OrgKind;
  postings: SamplePosting[];
};

const DESIGN_ROLE =
  'You will own end-to-end product flows, from the first sketch to what ships, and talk to customers every week. We work in small teams with an engineer and a PM, and we write things down.\n\nWhat you bring: five or more years designing software people use daily, a portfolio that shows your reasoning, and comfort with a design system you did not build.';

export const SAMPLE_BOARDS = {
  employer: {
    slug: SAMPLE_BOARD_SLUGS.employer,
    name: 'Northwind',
    kind: 'COMPANY',
    postings: [
      {
        slug: 'senior-product-designer',
        title: 'Senior Product Designer',
        group: 'Design',
        location: 'New York, NY',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        salary: [150000, 185000],
        description: DESIGN_ROLE,
      },
      {
        slug: 'brand-designer',
        title: 'Brand Designer',
        group: 'Design',
        location: 'Remote — US',
        workplaceType: 'REMOTE',
        commitment: 'CONTRACT',
        description:
          'A six-month contract to carry our new identity through the website, the product, and everything we send. You will work with our design lead and a copywriter.',
      },
      {
        slug: 'founding-engineer',
        title: 'Founding Engineer',
        group: 'Engineering',
        location: 'San Francisco, CA',
        workplaceType: 'ONSITE',
        commitment: 'FULL_TIME',
        salary: [170000, 220000],
        description:
          'One of our first five engineers. You will build across the stack in TypeScript and Postgres, own features from the schema to the pixels, and help decide how we work.',
      },
      {
        slug: 'staff-engineer-platform',
        title: 'Staff Engineer, Platform',
        group: 'Engineering',
        location: 'Remote — US',
        workplaceType: 'REMOTE',
        commitment: 'FULL_TIME',
        salary: [200000, 250000],
        description:
          'Make the platform fast and boring: data modelling, background jobs, observability, and the paved roads the rest of the team builds on.',
      },
      {
        slug: 'data-engineer',
        title: 'Data Engineer',
        group: 'Engineering',
        location: 'Austin, TX',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        salary: [150000, 180000],
        description:
          'Own the pipelines behind our reporting: ingestion, modelling, and the tables the whole company reads. dbt and SQL daily; Python when it helps.',
      },
    ],
  },
  agency: {
    slug: SAMPLE_BOARD_SLUGS.agency,
    name: 'Harbor Talent',
    kind: 'AGENCY',
    postings: [
      {
        slug: 'senior-product-designer',
        title: 'Senior Product Designer',
        group: 'Meridian Health',
        location: 'New York, NY',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        salary: [150000, 185000],
        description: DESIGN_ROLE,
      },
      {
        slug: 'clinical-data-analyst',
        title: 'Clinical Data Analyst',
        group: 'Meridian Health',
        location: 'Boston, MA',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        salary: [110000, 135000],
        description:
          'Turn clinical and operational data into answers the care teams use. SQL daily, a feel for healthcare data, and care with privacy.',
      },
      {
        slug: 'founding-engineer',
        title: 'Founding Engineer',
        group: 'Relay',
        location: 'San Francisco, CA',
        workplaceType: 'ONSITE',
        commitment: 'FULL_TIME',
        salary: [170000, 220000],
        description:
          'Relay is a seed-stage logistics startup hiring its first engineers. Build across the stack and help shape the product and the team.',
      },
      {
        slug: 'staff-engineer-platform',
        title: 'Staff Engineer, Platform',
        group: 'Relay',
        location: 'Remote — US',
        workplaceType: 'REMOTE',
        commitment: 'FULL_TIME',
        salary: [200000, 250000],
        description:
          'Own reliability and the developer platform as Relay grows from one product to three.',
      },
      {
        slug: 'head-of-sales',
        title: 'Head of Sales',
        group: 'Relay',
        location: 'Austin, TX',
        workplaceType: 'HYBRID',
        commitment: 'FULL_TIME',
        description:
          'Relay’s first sales leader: build the team and the playbook, and close the first enterprise customers yourself.',
      },
    ],
  },
} satisfies Record<'employer' | 'agency', SampleBoard>;

// The sample presentation: Harbor Talent presenting a candidate to Meridian
// Health, at /share/<SAMPLE_PRESENTATION_CODE>.

const PRESENTED = {
  name: 'Jordan Alvarez',
  headline: 'Senior Product Designer at Northbeam',
  location: 'Brooklyn, NY',
  email: 'jordan.alvarez@example.com',
  phone: '+1 555 0142',
  about:
    'Product designer with eight years across B2B software, most recently leading design for Northbeam’s hiring platform. I built and ran a token-based design system mirrored in React, which cut design QA time roughly in half, and led the redesign of the candidate pipeline around stage aging.\n\nBefore Northbeam I designed care-coordination tools at a digital health startup, where I learned to design for regulated workflows and very busy people.\n\nI like small teams, writing things down, and talking to customers every week.',
  summary:
    'A systems-minded designer who ships. Jordan built and ran Northbeam’s design system and led the pipeline redesign that recruiters there still use daily. The portfolio review showed clear reasoning and strong product judgment; the healthcare background fits Meridian’s regulated workflows.',
  strengths: ['Design systems at scale', 'B2B product judgment', 'Healthcare experience', 'Clear written reasoning'],
};

// ---------------------------------------------------------------------------

/** The sample board behind a slug, seeded if it isn't there yet. Null for other slugs. */
export async function ensureSampleBoard(slug: string): Promise<void> {
  const board = Object.values(SAMPLE_BOARDS).find((b) => b.slug === slug);
  if (!board) return;
  if (await db.organization.findUnique({ where: { slug }, select: { id: true } })) return;
  try {
    await seedBoard(board);
  } catch (err) {
    // Two first visits at once: the other request created it.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
}

/** The agency board and its sample presentation, for /share/<SAMPLE_PRESENTATION_CODE>. */
export async function ensureSamplePresentation(): Promise<void> {
  await ensureSampleBoard(SAMPLE_BOARDS.agency.slug);
  // The whole resume and their work, for boards seeded before either existed
  const org = await db.organization.findUnique({ where: { slug: SAMPLE_BOARDS.agency.slug }, select: { id: true } });
  if (org) await ensureSampleWork(org.id, PRESENTED.email);
}

async function seedBoard(board: SampleBoard) {
  await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: board.name, slug: board.slug, kind: board.kind, onboardedAt: new Date() },
    });
    await tx.stage.createMany({ data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: org.id })) });

    const groups = new Map<string, string>();
    for (const name of [...new Set(board.postings.map((p) => p.group))]) {
      const group =
        board.kind === 'AGENCY'
          ? await tx.clientCompany.create({ data: { orgId: org.id, name } })
          : await tx.department.create({ data: { orgId: org.id, name } });
      groups.set(name, group.id);
    }

    const postings = new Map<string, string>();
    for (const p of board.postings) {
      const posting = await tx.posting.create({
        data: {
          orgId: org.id,
          ...(board.kind === 'AGENCY' ? { clientCompanyId: groups.get(p.group) } : { departmentId: groups.get(p.group) }),
          slug: p.slug,
          title: p.title,
          state: 'PUBLISHED',
          location: p.location,
          workplaceType: p.workplaceType,
          commitment: p.commitment,
          ...(p.salary ? { salaryMin: p.salary[0], salaryMax: p.salary[1], salaryCurrency: 'USD' } : {}),
          content: { description: p.description },
        },
      });
      postings.set(p.slug, posting.id);
    }

    if (board.kind !== 'AGENCY') return;

    // The presented candidate, on the design role at Meridian Health.
    const stage = await tx.stage.findFirstOrThrow({ where: { orgId: org.id, type: 'ONSITE' } });
    const contact = await tx.contact.create({
      data: {
        orgId: org.id,
        name: PRESENTED.name,
        headline: PRESENTED.headline,
        location: PRESENTED.location,
        emails: [PRESENTED.email],
        phones: [PRESENTED.phone],
        links: [],
        tags: [],
        resumeText: PRESENTED.about,
      },
    });
    const opportunity = await tx.opportunity.create({
      data: {
        orgId: org.id,
        contactId: contact.id,
        postingId: postings.get('senior-product-designer'),
        stageId: stage.id,
        origin: 'SOURCED',
      },
    });
    await tx.aiEvaluation.create({
      data: {
        orgId: org.id,
        opportunityId: opportunity.id,
        model: 'sample',
        recommendation: 4,
        summary: PRESENTED.summary,
        strengths: PRESENTED.strengths,
        concerns: [],
        questions: [],
      },
    });
    await tx.shareLink.create({
      data: {
        code: SAMPLE_PRESENTATION_CODE,
        orgId: org.id,
        scope: 'candidate',
        targetId: opportunity.id,
        expiresAt: new Date('2099-12-31T00:00:00Z'),
      },
    });
  });
}
