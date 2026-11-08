import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bot,
  Briefcase,
  CalendarCheck,
  CalendarRange,
  CalendarDays,
  Clock,
  Home,
  Inbox,
  Kanban,
  ListTodo,
  Newspaper,
  Search,
  Settings,
  UserPlus,
  Users,
} from 'lucide-react';
import { SourceLockup } from '@/components/powered-by';
import { surface } from '@/components/form-controls';
import { Badge, type Tone } from '@/components/ui/primitives';
import { HR_POLICY } from '@/lib/hr-policy';

export const metadata = { title: 'Help · Orqestra' };

type Item = { icon: LucideIcon; name: string; href: string; what: string; who?: string };

const NAV: { title: string; items: Item[] }[] = [
  {
    title: 'Overview',
    items: [
      { icon: Home, name: 'Dashboard', href: '/dashboard', what: 'Your starting point: a short setup checklist, your pending approvals and upcoming interviews.' },
      { icon: Search, name: 'Search', href: '/search', what: 'Find any candidate, contact, note or transcript. Ask AI answers questions across them, when AI is connected.' },
      { icon: Inbox, name: 'Review', href: '/review', what: 'Things waiting for you to look at: new applications and meetings to check.' },
    ],
  },
  {
    title: 'Hiring',
    items: [
      { icon: Kanban, name: 'Pipeline', href: '/pipeline', what: 'Candidates grouped by stage (for example Applied, Screen, Offer). Use a candidate’s stage dropdown to move them on.' },
      { icon: Users, name: 'Contacts', href: '/contacts', what: 'Every person in your system, including candidates and people you have spoken to.' },
      { icon: UserPlus, name: 'Referrals', href: '/referrals', what: 'Suggest someone you know for a role. You can see where they are in the pipeline.' },
      { icon: Briefcase, name: 'Postings', href: '/postings', what: 'Open roles. A posting can be a Draft (not visible), Published (on your careers page) or Closed.' },
      { icon: CalendarDays, name: 'Interviews', href: '/interviews', what: 'Scheduled, completed and canceled interviews, with the interviewers and their scorecards.' },
      { icon: ListTodo, name: 'Tasks', href: '/tasks', what: 'Things to do on candidates. Overdue tasks are shown first.' },
      { icon: Newspaper, name: 'Newsletters', href: '/newsletters', what: 'Send an email update to a list of subscribers.' },
    ],
  },
  {
    title: 'People and time',
    items: [
      { icon: Clock, name: 'Attendance', href: '/attendance', what: 'Check in and check out for your own day. The team list shows who is in today.', who: 'Everyone' },
      { icon: CalendarRange, name: 'Leave', href: '/leave', what: 'Request time off, see your balance, and (for admins) approve or reject requests.', who: 'Everyone; approvals for admins' },
      { icon: Bot, name: 'AI agents', href: '/agents', what: 'Automatic checks that read your records and report what needs a person. Admins can run them.', who: 'Everyone reads; admins run' },
    ],
  },
  {
    title: 'Insights and settings',
    items: [
      { icon: BarChart3, name: 'Reports', href: '/reports', what: 'Charts and saved reports about hiring.' },
      { icon: Settings, name: 'Settings', href: '/settings', what: 'Business information, hiring stages, email, team members and their roles, and integrations.', who: 'Admins for business, team and integrations' },
    ],
  },
];

const STATUS: { label: string; tone?: Tone; meaning: string }[] = [
  { label: 'In', tone: 'positive', meaning: 'You have checked in today, on time.' },
  { label: 'Late', tone: 'caution', meaning: `You checked in after ${minutesToClock(parseHM(HR_POLICY.workStart) + HR_POLICY.graceMinutes)}. Late is only a note, not a mark against you.` },
  { label: 'Not checked in', tone: 'caution', meaning: 'No check-in yet. After the start time and grace period, the Attendance agent lists this for review.' },
  { label: 'Done', meaning: 'You have checked in and out for the day.' },
  { label: 'No check-out', tone: 'critical', meaning: 'A past day that was never checked out. Someone should correct it.' },
  { label: 'Off day', meaning: 'A weekend. No check-in is needed.' },
  { label: 'Pending', tone: 'caution', meaning: 'A leave request waiting for an admin to decide.' },
  { label: 'Approved', tone: 'positive', meaning: 'Leave was approved. The days count against your balance.' },
  { label: 'Rejected', tone: 'critical', meaning: 'Leave was not approved. The days are not used.' },
];

const GLOSSARY: { term: string; meaning: string }[] = [
  { term: 'Stage', meaning: 'A step a candidate moves through, such as Applied, Screen, Onsite, Offer or Hired.' },
  { term: 'Scorecard', meaning: 'An interviewer’s rating and notes after an interview. Scores are 1 to 4.' },
  { term: 'Opportunity', meaning: 'One candidate applying for one role. A person can have several.' },
  { term: 'Archive', meaning: 'Closing a candidate with a reason (for example “Not a fit”). It can be undone.' },
  { term: 'AI agent', meaning: 'A checker that reads your real records and reports. It does not change anything or decide anything on its own. Every run is logged.' },
  { term: 'Approval', meaning: 'A decision an admin must make before something takes effect, such as leave or an offer.' },
  { term: 'Balance', meaning: 'Days of leave left: the annual allowance minus approved days. Weekends are never counted.' },
  { term: 'Grace period', meaning: `Minutes after the ${HR_POLICY.workStart} start time before a check-in counts as late (${HR_POLICY.graceMinutes} minutes).` },
];

function parseHM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToClock(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const STEPS_MANAGER = [
  { title: 'Open a role', body: 'Go to Postings → New posting. Publish it when it is ready, and it appears on your careers page.' },
  { title: 'Add candidates', body: 'Go to Pipeline or Contacts → New candidate. Use a candidate’s stage dropdown to move them as they progress.' },
  { title: 'Schedule and score', body: 'Open a candidate, add an interview, then have each interviewer submit a scorecard.' },
  { title: 'Approve leave', body: 'Go to Leave. Requests waiting for you are at the top. Approve or reject with an optional note.' },
  { title: 'Check the agents', body: 'Go to AI agents to see what needs attention. Click Run now to refresh a check.' },
];

const STEPS_EMPLOYEE = [
  { title: 'Check in', body: 'Go to Attendance and press Check in when you start. Press Check out when you finish.' },
  { title: 'Request leave', body: 'Go to Leave, pick the type and dates, add a reason, and send. Weekends are not counted.' },
  { title: 'See your status', body: 'Your request shows as Pending, Approved or Rejected. Your balance is shown above the form.' },
  { title: 'Refer someone', body: 'Go to Referrals to suggest a person you know for an open role.' },
];

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <SourceLockup href="/" />
        <Link href="/login" className="rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:text-ink">
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pb-10 pt-6">
          <h1 className="text-3xl font-semibold tracking-[-0.02em]">Help</h1>
          <p className="mt-2 max-w-2xl text-md text-ink-2">
            Where to find things in Orqestra, what each menu item is for, and what the words on the
            screen mean. Start with the steps for your role.
          </p>
          <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2 text-sm">
            {[
              ['#start', 'Getting started'],
              ['#menu', 'Menu guide'],
              ['#status', 'What the labels mean'],
              ['#terms', 'Terms'],
            ].map(([href, label]) => (
              <a key={href} href={href} className="rounded-full bg-surface px-3 py-1.5 text-ink-2 hover:text-ink">
                {label}
              </a>
            ))}
          </nav>
        </section>

        <section id="start" className="scroll-mt-6 pb-14">
          <h2 className="mb-4 text-xl font-medium">Getting started</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <RoleCard
              title="Manager or recruiter"
              href="/demo/manager"
              hrefLabel="Try the manager demo"
              steps={STEPS_MANAGER}
              note="Admins can approve leave, run agents, and change settings."
            />
            <RoleCard
              title="Employee"
              href="/demo/employee"
              hrefLabel="Try the employee demo"
              steps={STEPS_EMPLOYEE}
              note="Employees see their own leave requests, and the team’s check-in list."
            />
          </div>
          <p className="mt-4 text-xs text-ink-2">
            The demo links sign you into a sample workspace with no account. Each demo sign-in starts
            with a clean slate.
          </p>
        </section>

        <section id="menu" className="scroll-mt-6 pb-14">
          <h2 className="mb-1 text-xl font-medium">Menu guide</h2>
          <p className="mb-5 text-sm text-ink-2">Each item in the left menu, and what it is for.</p>
          <div className="flex flex-col gap-8">
            {NAV.map((group) => (
              <div key={group.title}>
                <h3 className="mb-3 text-xs font-medium text-ink-2">{group.title}</h3>
                <div className={`${surface} divide-y divide-line overflow-hidden`}>
                  {group.items.map(({ icon: Icon, name, href, what, who }) => (
                    <Link key={href} href={href} className="flex gap-4 px-5 py-4 transition-colors duration-[120ms] hover:bg-muted/60">
                      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Icon size={16} strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{name}</span>
                          {who ? <Badge>{who}</Badge> : null}
                        </span>
                        <span className="mt-1 block text-sm text-ink-2">{what}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="status" className="scroll-mt-6 pb-14">
          <h2 className="mb-1 text-xl font-medium">What the labels mean</h2>
          <p className="mb-5 text-sm text-ink-2">The coloured dot shows the tone: green is good, amber needs a look, red needs action.</p>
          <div className={`${surface} divide-y divide-line overflow-hidden`}>
            {STATUS.map((s) => (
              <div key={s.label} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-6">
                <span className="w-44 shrink-0">
                  <Badge tone={s.tone}>{s.label}</Badge>
                </span>
                <span className="text-sm text-ink-2">{s.meaning}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="terms" className="scroll-mt-6 pb-14">
          <h2 className="mb-4 text-xl font-medium">Terms</h2>
          <dl className={`${surface} grid gap-px overflow-hidden bg-line sm:grid-cols-2`}>
            {GLOSSARY.map((g) => (
              <div key={g.term} className="bg-surface p-5">
                <dt className="text-sm font-medium">{g.term}</dt>
                <dd className="mt-1 text-sm text-ink-2">{g.meaning}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-card bg-surface p-6">
          <h2 className="text-md font-medium">Something not covered?</h2>
          <p className="mt-1 text-sm text-ink-2">
            Ask the person who set up your workspace, or go to <Link href="/settings" className="font-medium text-ink hover:underline">Settings</Link>.
            Attendance, leave and agent rules are set by your administrator.
          </p>
          <p className="mt-3 flex items-center gap-2 text-xs text-ink-2">
            <CalendarCheck size={14} /> Working hours: {HR_POLICY.workStart} start, {HR_POLICY.graceMinutes}-minute grace, {HR_POLICY.standardHours}-hour day, Friday and Saturday off ({HR_POLICY.timezone}).
          </p>
        </section>
      </main>
    </div>
  );
}

function RoleCard({
  title,
  href,
  hrefLabel,
  steps,
  note,
}: {
  title: string;
  href: string;
  hrefLabel: string;
  steps: { title: string; body: string }[];
  note: string;
}) {
  return (
    <article className={`${surface} flex flex-col gap-4 p-6`}>
      <div>
        <h3 className="text-md font-medium">{title}</h3>
        <p className="mt-1 text-sm text-ink-2">{note}</p>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {i + 1}
            </span>
            <span>
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="block text-sm text-ink-2">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <a href={href} className="mt-auto inline-flex w-fit items-center rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">
        {hrefLabel}
      </a>
    </article>
  );
}
