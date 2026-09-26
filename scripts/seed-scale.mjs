#!/usr/bin/env node
/**
 * Seed a large, realistic workspace for performance work.
 *
 *   npm run seed:scale                      # 50k contacts into org "scale"
 *   npm run seed:scale -- --contacts 200000 --slug big
 *
 * LOCAL DATABASES ONLY. It refuses to run unless DATABASE_URL points at
 * localhost or the docker-compose `db` host — never aim it at production.
 * Generation is deterministic (seeded PRNG), so two runs with the same
 * arguments produce the same content (ids differ), so benchmarks compare.
 *
 * Sign in afterwards as scale@source.local / scale-password.
 */
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const CONTACTS = Number(args.contacts ?? 50_000);
const SLUG = String(args.slug ?? 'scale');
if (!Number.isInteger(CONTACTS) || CONTACTS < 1 || !/^[a-z0-9-]+$/.test(SLUG)) {
  console.error('Usage: npm run seed:scale -- [--contacts 50000] [--slug scale]');
  process.exit(1);
}
const CHUNK = 2_000;

const url = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
let host = '';
try {
  host = new URL(url).hostname;
} catch {}
if (!['localhost', '127.0.0.1', '::1', 'db'].includes(host)) {
  console.error(`[seed:scale] Refusing to seed "${host || 'unknown host'}" — local databases only.`);
  process.exit(1);
}

const db = new PrismaClient({ datasources: { db: { url } } });

// ---------- deterministic generation ----------

let state = 0x9e3779b9;
function rand() {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;
const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * DAY);

const FIRST = 'Maya Jordan Sam Priya Diego Alex Riley Casey Morgan Avery Quinn Harper Rowan Emerson Noah Liam Olivia Emma Ava Sophia Mia Lucas Ethan Mason Logan Aiden Chloe Zoe Nora Leah Omar Yusuf Mei Hiro Anika Ravi Sofia Mateo Isabella Camila Tariq Amara Kwame Ingrid Lars Freya Nikolai Elena Dmitri Aisha'.split(' ');
const LAST = 'Chen Alvarez Whitfield Nair Ramos Kim Okonkwo Patel Garcia Nguyen Smith Johnson Williams Brown Jones Miller Davis Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Thompson White Harris Clark Lewis Robinson Walker Young Allen King Wright Scott Torres Hill Green Adams Baker Nelson Carter Mitchell Perez Roberts Turner Phillips Campbell Parker Evans Edwards Collins Stewart Sanchez Morris Rogers Reed Cook Morgan Bell Murphy Bailey Rivera Cooper Richardson Cox Howard Ward Peterson Gray James Watson Brooks Kelly Sanders Price Bennett Wood Barnes Ross Henderson Coleman Jenkins Perry Powell Long Patterson Hughes Flores Washington Butler Simmons Foster Gonzales Bryant Alexander Russell Griffin Diaz Hayes Nakamura Sato Ivanova Kowalski Haddad'.split(' ');
const ROLES = ['Product Designer', 'Senior Product Designer', 'Staff Engineer', 'Software Engineer', 'Frontend Engineer', 'Backend Engineer', 'Data Scientist', 'Engineering Manager', 'Product Manager', 'Recruiter', 'Account Executive', 'Customer Success Manager', 'DevOps Engineer', 'Security Engineer', 'Design Lead', 'ML Engineer', 'QA Engineer', 'Technical Writer', 'Marketing Manager', 'Sales Engineer'];
const COMPANIES = ['Figment', 'Northbeam', 'Relay', 'Meridian Health', 'Lattice', 'Parcel', 'Acme', 'Globex', 'Initech', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Umbrella', 'Vandelay', 'Pied Piper', 'Aperture', 'Cyberdyne', 'Soylent', 'Tyrell', 'Wonka', 'Oscorp', 'Massive Dynamic', 'Nakatomi', 'Gringotts', 'Monarch'];
const CITIES = ['Brooklyn, NY', 'Austin, TX', 'San Francisco, CA', 'Chicago, IL', 'Denver, CO', 'Seattle, WA', 'Boston, MA', 'Atlanta, GA', 'Los Angeles, CA', 'Portland, OR', 'Miami, FL', 'Toronto, ON', 'London, UK', 'Berlin, DE', 'Remote'];
const SKILLS = ['TypeScript', 'React', 'Next.js', 'Postgres', 'Prisma', 'Python', 'Go', 'Rust', 'Kubernetes', 'AWS', 'Figma', 'design systems', 'user research', 'prototyping', 'GraphQL', 'Kafka', 'Terraform', 'machine learning', 'SQL', 'dbt', 'Swift', 'Kotlin', 'accessibility', 'analytics', 'A/B testing'];
const TAGS = ['design-systems', 'typescript', 'infra', 'leadership', 'referral', 'silver-medalist', 'relocation', 'visa', 'remote-only', 'bootcamp', 'ex-faang', 'founding'];
const DEPARTMENTS = ['Engineering', 'Design', 'Product', 'Sales', 'Marketing', 'People'];

function resume(name, role, company) {
  const lines = [`${name} — ${role}`, `${int(2, 15)} years of experience. Currently ${role} at ${company}.`];
  for (let i = 0; i < int(6, 14); i++) {
    lines.push(
      `${pick(['Led', 'Built', 'Shipped', 'Designed', 'Scaled', 'Owned', 'Rebuilt', 'Launched'])} ${pick(['the onboarding flow', 'a billing platform', 'an internal design system', 'the search experience', 'a data pipeline', 'the mobile app', 'reporting dashboards', 'the hiring funnel'])} using ${pick(SKILLS)} and ${pick(SKILLS)}; ${pick(['improved activation', 'cut latency', 'reduced churn', 'lifted conversion', 'halved QA time'])} by ${int(5, 60)}%.`,
    );
  }
  lines.push(`Skills: ${Array.from({ length: 6 }, () => pick(SKILLS)).join(', ')}.`);
  return lines.join('\n');
}

function transcript(name) {
  const lines = [];
  for (let i = 0; i < int(20, 45); i++) {
    lines.push(
      i % 2 === 0
        ? `Interviewer: ${pick(['Walk me through', 'Tell me about', 'How did you approach', 'What was hard about'])} ${pick(['your last project', 'a difficult trade-off', 'working with design', 'scaling the system', 'a conflict on the team'])}?`
        : `${name.split(' ')[0]}: ${pick(['We started by', 'The core problem was', 'I pushed for', 'Honestly, we'])} ${pick(['measuring the baseline', 'talking to customers', 'cutting scope', 'rewriting the data layer', 'pairing with the PM'])}, and ${pick(['it paid off', 'we learned a lot', 'the metrics moved', 'it took three iterations'])}. ${pick(SKILLS)} was central to it.`,
    );
  }
  return lines.join('\n');
}

async function insert(model, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db[model].createMany({ data: rows.slice(i, i + CHUNK) });
  }
}

// ---------- seed ----------

const started = performance.now();
const log = (msg) => console.log(`[seed:scale] ${((performance.now() - started) / 1000).toFixed(1)}s  ${msg}`);

if (await db.organization.findUnique({ where: { slug: SLUG } })) {
  console.error(`[seed:scale] Org "${SLUG}" already exists — pass --slug to seed another.`);
  process.exit(1);
}

const orgId = randomUUID();
await db.organization.create({ data: { id: orgId, name: 'Scale Co', slug: SLUG, onboardedAt: new Date() } });
const passwordHash = await bcrypt.hash('scale-password', 10);
const users = Array.from({ length: 25 }, (_, i) => ({
  id: randomUUID(),
  orgId,
  email: i === 0 ? 'scale@source.local' : `recruiter${i}@source.local`,
  name: i === 0 ? 'Scale Admin' : `${pick(FIRST)} ${pick(LAST)}`,
  passwordHash,
  accessRole: i === 0 ? 'SUPER_ADMIN' : 'TEAM_MEMBER',
}));
await insert('user', users);

const stages = [
  ['New applicant', 'APPLICANT'],
  ['Phone screen', 'SCREEN'],
  ['On-site', 'ONSITE'],
  ['Offer', 'OFFER'],
  ['Hired', 'HIRED'],
].map(([name, type], order) => ({ id: randomUUID(), orgId, name, type, order }));
await insert('stage', stages);
const reasons = ['Underqualified', 'Culture / values mismatch', 'Timing', 'Withdrew', 'Position filled'].map((name, i) => ({
  id: randomUUID(),
  orgId,
  name,
  countsAsRejection: i < 2,
}));
await insert('archiveReason', reasons);

const departments = DEPARTMENTS.map((name) => ({ id: randomUUID(), orgId, name }));
await insert('department', departments);
const postings = Array.from({ length: 40 }, (_, i) => {
  const title = `${pick(ROLES)}${i >= ROLES.length ? ` (${pick(CITIES).split(',')[0]})` : ''}`;
  return {
    id: randomUUID(),
    orgId,
    departmentId: pick(departments).id,
    slug: `role-${i}`,
    title,
    state: i < 30 ? 'PUBLISHED' : pick(['DRAFT', 'CLOSED', 'INTERNAL']),
    location: pick(CITIES),
    workplaceType: pick(['ONSITE', 'HYBRID', 'REMOTE']),
    content: { description: `We are hiring a ${title}.` },
    createdAt: daysAgo(int(30, 400)),
  };
});
await insert('posting', postings);
log(`org ${SLUG}: 25 users, 40 postings`);

// Contacts, opportunities, and the stage history analytics reads.
const contacts = [];
const opportunities = [];
const transitions = [];
for (let i = 0; i < CONTACTS; i++) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const role = pick(ROLES);
  const company = pick(COMPANIES);
  const createdDays = int(0, 720);
  const contactId = randomUUID();
  contacts.push({
    id: contactId,
    orgId,
    name,
    headline: `${role} at ${company}`,
    location: pick(CITIES),
    emails: [`${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example.com`],
    phones: chance(0.5) ? [`+1 555 ${String(int(1000000, 9999999))}`] : [],
    links: chance(0.4) ? [`linkedin.com/in/${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${i}`] : [],
    tags: chance(0.3) ? [pick(TAGS)] : [],
    resumeText: chance(0.85) ? resume(name, role, company) : null,
    createdAt: daysAgo(createdDays),
  });

  for (let o = 0; o < (chance(0.15) ? 2 : 1); o++) {
    const opened = Math.max(0, createdDays - o * int(30, 120));
    // Most candidates stall early; a few reach offer / hired.
    // Geometric-ish: ~60% stall at applicant, ~2–3% make it to hired.
    const depth = Math.min(4, Math.floor(-Math.log(1 - rand() * 0.999) / 0.9));
    const archived = depth < 4 && opened > 45 && chance(0.7);
    const status = depth === 4 ? 'HIRED' : archived ? 'ARCHIVED' : 'ACTIVE';
    const oppId = randomUUID();
    let at = daysAgo(opened).getTime();
    for (let s = 0; s <= depth; s++) {
      transitions.push({
        id: randomUUID(),
        opportunityId: oppId,
        fromStageId: s === 0 ? null : stages[s - 1].id,
        toStageId: stages[s].id,
        actorId: pick(users).id,
        occurredAt: new Date(at),
      });
      if (s < depth) at = Math.min(NOW, at + int(1, 14) * DAY);
    }
    opportunities.push({
      id: oppId,
      orgId,
      contactId,
      postingId: chance(0.9) ? pick(postings).id : null,
      stageId: stages[depth].id,
      status,
      origin: pick(['APPLIED', 'APPLIED', 'APPLIED', 'SOURCED', 'SOURCED', 'REFERRED', 'AGENCY']),
      ownerId: pick(users).id,
      archiveReasonId: archived ? pick(reasons).id : null,
      archivedAt: archived ? new Date(Math.min(NOW, at + int(1, 20) * DAY)) : null,
      stageChangedAt: new Date(at),
      createdAt: daysAgo(opened),
    });
  }
}
await insert('contact', contacts);
log(`${contacts.length} contacts`);
await insert('opportunity', opportunities);
log(`${opportunities.length} opportunities`);
await insert('stageTransition', transitions);
log(`${transitions.length} stage transitions`);

// Collaboration + interview corpus on a slice of the pipeline.
const deep = opportunities.filter((o) => o.stageId !== stages[0].id);
const byContact = new Map(contacts.map((c) => [c.id, c]));
const notes = [];
const interviews = [];
const feedback = [];
const transcripts = [];
const tasks = [];
const panels = []; // [interviewId, userId] rows for the implicit _InterviewPanelists table
const events = [];
for (const opp of opportunities) {
  if (chance(0.2)) {
    notes.push({
      id: randomUUID(),
      orgId,
      opportunityId: opp.id,
      authorId: pick(users).id,
      body: `${pick(['Strong', 'Solid', 'Mixed', 'Promising'])} signal on ${pick(SKILLS)}. ${pick(['Follow up on comp.', 'Check references.', 'Loop in the hiring manager.', 'Move quickly — has other offers.'])}`,
      createdAt: opp.stageChangedAt,
    });
  }
  events.push({
    id: randomUUID(),
    orgId,
    actorType: 'user',
    actorId: opp.ownerId,
    verb: 'opportunity.created',
    subjectType: 'opportunity',
    subjectId: opp.id,
    occurredAt: opp.createdAt,
  });
}
for (const opp of deep) {
  if (!chance(0.6)) continue;
  const interviewId = randomUUID();
  const past = opp.status !== 'ACTIVE' || chance(0.7);
  const panel = [...new Set(Array.from({ length: int(1, 3) }, () => pick(users).id))];
  for (const userId of panel) panels.push([interviewId, userId]);
  interviews.push({
    id: interviewId,
    orgId,
    opportunityId: opp.id,
    title: pick(['Phone screen', 'Portfolio review', 'System design', 'Team fit', 'Hiring manager chat']),
    startAt: new Date(
      (past ? opp.stageChangedAt.getTime() - int(1, 5) * DAY : NOW + int(1, 14) * DAY) +
        int(0, 16) * 30 * 60_000, // spread across the working day
    ),
    durationMins: pick([30, 45, 60]),
    state: past ? 'COMPLETED' : 'SCHEDULED',
  });
  if (past) {
    feedback.push({
      id: randomUUID(),
      orgId,
      opportunityId: opp.id,
      interviewId,
      authorId: panel[0], // scorecards come from the panel
      overallRating: int(1, 4),
      summary: `${pick(['Clear communicator', 'Deep on systems', 'Needs more depth', 'Great product sense'])}; ${pick(['advance', 'hold', 'reject', 'strong advance'])}.`,
    });
    if (chance(0.3)) {
      transcripts.push({
        id: randomUUID(),
        orgId,
        opportunityId: opp.id,
        interviewId,
        title: `Interview — ${byContact.get(opp.contactId).name}`,
        content: transcript(byContact.get(opp.contactId).name),
        createdAt: opp.stageChangedAt,
      });
    }
  }
  if (opp.status === 'ACTIVE' && chance(0.3)) {
    tasks.push({
      id: randomUUID(),
      orgId,
      opportunityId: opp.id,
      assigneeId: pick(users).id,
      title: pick(['Schedule next round', 'Send prep materials', 'Collect references', 'Share feedback']),
      dueAt: new Date(NOW + int(-5, 10) * DAY),
    });
  }
}
await insert('note', notes);
await insert('interview', interviews);
// Implicit many-to-many has no Prisma model, so createMany can't reach it.
for (let i = 0; i < panels.length; i += CHUNK) {
  const chunk = panels.slice(i, i + CHUNK);
  await db.$executeRaw`INSERT INTO "_InterviewPanelists" ("A", "B")
    SELECT * FROM unnest(${chunk.map((p) => p[0])}::text[], ${chunk.map((p) => p[1])}::text[])`;
}
await insert('feedbackSubmission', feedback);
await insert('transcript', transcripts);
await insert('task', tasks);
await insert('event', events);
log(
  `${notes.length} notes, ${interviews.length} interviews (${panels.length} panelist seats), ${feedback.length} scorecards, ${transcripts.length} transcripts, ${tasks.length} tasks, ${events.length} events`,
);

await db.$executeRawUnsafe('ANALYZE');
log('done — sign in as scale@source.local / scale-password');
await db.$disconnect();
