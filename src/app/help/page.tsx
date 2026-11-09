import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bot,
  Briefcase,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  Clock,
  Home,
  Inbox,
  Kanban,
  ListTodo,
  Newspaper,
  Search,
  Settings,
  Trophy,
  UserPlus,
  Users,
  UserCircle,
} from 'lucide-react';
import { SourceLockup } from '@/components/powered-by';
import { HR_POLICY } from '@/lib/hr-policy';

export const metadata = { title: 'Help · Orqestra' };

type Feature = {
  icon: LucideIcon;
  name: string;
  what: string;
  steps: string[];
  who: string;
};

type Section = { id: string; title: string; intro: string; features: Feature[] };

const SECTIONS: Section[] = [
  {
    id: 'company',
    title: 'For companies: recruiters and managers',
    intro: 'These pages are for the people who hire and manage the team. They sit inside the signed-in app.',
    features: [
      {
        icon: Home,
        name: 'Dashboard',
        what: 'Your home page. It shows a setup checklist, what needs your approval, and upcoming interviews.',
        steps: ['Sign in and you land here.', 'Work through the checklist to set up your workspace.'],
        who: 'Everyone',
      },
      {
        icon: Briefcase,
        name: 'Postings (open roles)',
        what: 'The jobs you are hiring for. A role stays private while it is a Draft. Once you publish it, it appears on the public job board.',
        steps: [
          'Click Postings, then New posting.',
          'Enter a title, location, workplace type and pay, and add a description.',
          'Click Create draft. Open the role and click Publish when it is ready.',
        ],
        who: 'Recruiters and managers',
      },
      {
        icon: Kanban,
        name: 'Pipeline',
        what: 'Every candidate, grouped by stage such as Applied, Screen, Offer and Hired. This is where you move people forward.',
        steps: [
          'Click Pipeline and choose a stage tab.',
          'Open a candidate and use their stage dropdown to move them on.',
          'Moving someone to Hired records the hire. If they have a candidate account, the job appears in their My jobs.',
        ],
        who: 'Recruiters and managers',
      },
      {
        icon: Users,
        name: 'Contacts',
        what: 'Everyone in your system: applicants, referrals and people you have spoken to. One person can apply to several roles.',
        steps: ['Click Contacts to search or filter.', 'Click New candidate to add someone by hand.'],
        who: 'Recruiters and managers',
      },
      {
        icon: CalendarDays,
        name: 'Interviews',
        what: 'Scheduled, completed and cancelled interviews, with who is on the panel. Each panellist then submits a scorecard with a rating and notes.',
        steps: [
          'Open a candidate and add an interview from their profile.',
          'Pick the time, the panel and the place or video link.',
          'After the interview, each panellist submits a scorecard.',
        ],
        who: 'Recruiters and interviewers',
      },
      {
        icon: UserPlus,
        name: 'Referrals',
        what: 'Suggest someone you know for an open role. The referral goes into the pipeline, and you can see where they are.',
        steps: ['Click Referrals and enter the person’s name and email.', 'Choose the role and add a short note on why they fit.'],
        who: 'Everyone',
      },
      {
        icon: ListTodo,
        name: 'Tasks',
        what: 'Small to-dos on candidates, such as “call back” or “send feedback”. Overdue tasks show first.',
        steps: ['Open a candidate and add a task, with an optional due date.', 'Check Tasks each morning.'],
        who: 'Everyone',
      },
      {
        icon: Inbox,
        name: 'Review',
        what: 'Things waiting for you to look at, such as new applications and meeting notes.',
        steps: ['Click Review and work down the list.'],
        who: 'Recruiters and managers',
      },
      {
        icon: Search,
        name: 'Search',
        what: 'Find any candidate, contact, note or interview transcript from one box.',
        steps: ['Click Search and type a name, a role, or a word from a note.'],
        who: 'Everyone',
      },
      {
        icon: Newspaper,
        name: 'Newsletters',
        what: 'Send an email update to people who asked to hear from you.',
        steps: ['Click Newsletters and write a new one.', 'Choose who gets it, then send.'],
        who: 'Recruiters and managers',
      },
      {
        icon: BarChart3,
        name: 'Reports',
        what: 'Charts about hiring: how many applied, how long each stage takes, and where candidates drop out.',
        steps: ['Click Reports and pick the one you want.'],
        who: 'Managers and admins',
      },
    ],
  },
  {
    id: 'people',
    title: 'For your team: attendance, leave and agents',
    intro: 'These pages are for everyone in the company, not only recruiters.',
    features: [
      {
        icon: Clock,
        name: 'Attendance',
        what: `Record when you start and finish work. The day starts at ${HR_POLICY.workStart}, with a ${HR_POLICY.graceMinutes}-minute grace period before a check-in counts as late. Friday and Saturday are off days.`,
        steps: [
          'Click Attendance, then Check in when you start work.',
          'Click Check out when you finish.',
          'The team list shows who has checked in today.',
        ],
        who: 'Everyone',
      },
      {
        icon: CalendarRange,
        name: 'Leave',
        what: 'Ask for time off and see how many days you have left. Weekends are not counted. An admin must approve every request.',
        steps: [
          'Click Leave and pick the type: Annual, Sick or Unpaid.',
          'Choose the first and last day, and add a reason if you like.',
          'Click Request leave. It shows as Pending until an admin decides.',
        ],
        who: 'Everyone (admins approve)',
      },
      {
        icon: Bot,
        name: 'AI agents',
        what: 'Automatic checks that read your real records and list what needs a person. They never approve, reject or change anything, and every check is logged.',
        steps: [
          'Click AI agents to see the three checks and what they last found.',
          'Admins can click Run now to refresh a check.',
        ],
        who: 'Everyone reads; admins run',
      },
    ],
  },
  {
    id: 'candidate',
    title: 'For candidates: find a job and track it',
    intro: 'Candidates use one account for every company. You never need a company login.',
    features: [
      {
        icon: UserCircle,
        name: 'Create your account',
        what: 'One email and password for the whole platform. Any applications you made before creating it are linked to it automatically.',
        steps: [
          'Click Create account on the home page, or open /candidate/signup.',
          'Enter your name, email and a password of at least 8 characters.',
        ],
        who: 'Candidates',
      },
      {
        icon: Search,
        name: 'Find jobs',
        what: 'Every open role from every company, in one list. Search by title or city, and filter by workplace and type.',
        steps: ['Click Find jobs, or open /jobs.', 'Type in the search box or pick a filter, then click a role to read it.'],
        who: 'Anyone',
      },
      {
        icon: Briefcase,
        name: 'Apply',
        what: 'Send your application to a role. The company receives it with the name and email from your account.',
        steps: [
          'Open a role and read the description.',
          'Sign in, add an optional note, and click Submit application.',
          'You can apply once to each open role.',
        ],
        who: 'Candidates',
      },
      {
        icon: CalendarCheck,
        name: 'My applications and interviews',
        what: 'See each role you applied to, its status, and any upcoming interviews with the time and place.',
        steps: ['Sign in and open My jobs. Look at My applications and Upcoming interviews.'],
        who: 'Candidates',
      },
      {
        icon: Trophy,
        name: 'My jobs',
        what: 'When a company hires you, the job appears here with the company and start date. It stays in your account even if you later work for another company.',
        steps: ['Sign in and open My jobs. Your hired roles are at the top.'],
        who: 'Candidates',
      },
    ],
  },
  {
    id: 'admin',
    title: 'For admins: settings',
    intro: 'Settings controls how the company runs. Only admins can change the business, team and integration sections.',
    features: [
      {
        icon: Settings,
        name: 'Settings',
        what: 'Business information (name, logo, brand), hiring stages, email templates, team members and their roles, and integrations such as calendars and API keys.',
        steps: [
          'Click Settings and pick a section from the list at the top.',
          'Team: invite people and choose their role. Admins can approve leave and run agents.',
          'Hiring: rename or reorder the stages candidates move through.',
        ],
        who: 'Admins for business, team and integrations',
      },
    ],
  },
];

const STATUSES: { label: string; meaning: string }[] = [
  { label: 'In', meaning: 'You checked in today, on time.' },
  { label: 'Late', meaning: `You checked in after ${clock(parse(HR_POLICY.workStart) + HR_POLICY.graceMinutes)}. It is a note, not a penalty.` },
  { label: 'Not checked in', meaning: 'No check-in yet today.' },
  { label: 'Done', meaning: 'You checked in and out for the day.' },
  { label: 'No check-out', meaning: 'A past day with no check-out. Someone should correct it.' },
  { label: 'Off day', meaning: 'A weekend. No check-in needed.' },
  { label: 'Pending', meaning: 'Waiting for an admin to decide.' },
  { label: 'Approved', meaning: 'Approved. The days come off your balance.' },
  { label: 'Rejected', meaning: 'Not approved. The days are not used.' },
  { label: 'Draft', meaning: 'A role not yet visible outside the company.' },
  { label: 'Published', meaning: 'Visible on the job board and careers page.' },
  { label: 'Hired', meaning: 'The candidate accepted the role.' },
];

const TERMS: { term: string; meaning: string }[] = [
  { term: 'Stage', meaning: 'A step in hiring, such as Applied, Screen, Interview, Offer or Hired.' },
  { term: 'Scorecard', meaning: 'An interviewer’s rating (1 to 4) and notes after an interview.' },
  { term: 'Candidate account', meaning: 'Your personal login for every company on Orqestra.' },
  { term: 'Approval', meaning: 'A decision an admin must make before it takes effect, such as leave.' },
  { term: 'Balance', meaning: 'The days of leave you have left: your allowance minus approved days.' },
  { term: 'Grace period', meaning: `${HR_POLICY.graceMinutes} minutes after ${HR_POLICY.workStart} before a check-in counts as late.` },
  { term: 'AI agent', meaning: 'An automatic checker that reads your records and reports. It decides nothing.' },
];

function parse(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function clock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-white text-black">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-6">
        <SourceLockup href="/" />
        <Link href="/login" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-24">
        <section className="pb-10 pt-4">
          <h1 className="text-4xl font-semibold tracking-[-0.02em]">How Orqestra works</h1>
          <p className="mt-3 max-w-2xl text-lg">
            Each feature below says what it is for, what to do with it, and who can use it. Pick the
            part that matches what you need.
          </p>
          <nav aria-label="Jump to a section" className="mt-6 flex flex-wrap gap-2 text-base">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="rounded-full border border-line px-4 py-2 hover:bg-muted">
                {s.title.split(':')[0]}
              </a>
            ))}
            <a href="#labels" className="rounded-full border border-line px-4 py-2 hover:bg-muted">What the labels mean</a>
            <a href="#terms" className="rounded-full border border-line px-4 py-2 hover:bg-muted">Words explained</a>
          </nav>
        </section>

        {SECTIONS.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-6 pb-14">
            <h2 className="text-2xl font-semibold tracking-[-0.01em]">{section.title}</h2>
            <p className="mb-6 mt-2 text-base">{section.intro}</p>
            <div className="flex flex-col gap-4">
              {section.features.map((f) => (
                <article key={f.name} className="rounded-2xl bg-surface p-6">
                  <div className="flex items-start gap-4">
                    <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
                      <f.icon size={20} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 className="text-xl font-semibold">{f.name}</h3>
                        <span className="text-sm">Who: {f.who}</span>
                      </div>
                      <p className="mt-2 text-base">{f.what}</p>
                      <h4 className="mt-4 text-sm font-semibold uppercase tracking-wide">How to use it</h4>
                      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-base">
                        {f.steps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}

        <section id="labels" className="scroll-mt-6 pb-14">
          <h2 className="text-2xl font-semibold tracking-[-0.01em]">What the labels mean</h2>
          <p className="mb-5 mt-2 text-base">These words appear on badges and status lines across the app.</p>
          <dl className="grid gap-px overflow-hidden rounded-2xl bg-line sm:grid-cols-2">
            {STATUSES.map((s) => (
              <div key={s.label} className="bg-surface p-5">
                <dt className="text-base font-semibold">{s.label}</dt>
                <dd className="mt-1 text-base">{s.meaning}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="terms" className="scroll-mt-6 pb-14">
          <h2 className="text-2xl font-semibold tracking-[-0.01em]">Words explained</h2>
          <dl className="mt-5 grid gap-px overflow-hidden rounded-2xl bg-line sm:grid-cols-2">
            {TERMS.map((t) => (
              <div key={t.term} className="bg-surface p-5">
                <dt className="text-base font-semibold">{t.term}</dt>
                <dd className="mt-1 text-base">{t.meaning}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-2xl bg-brand p-8 text-on-brand">
          <h2 className="text-2xl font-semibold">Still stuck?</h2>
          <p className="mt-2 text-base text-on-brand">
            Ask the person who set up your workspace. Leave and attendance rules are set by your admin.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/jobs" className="rounded-full bg-surface px-5 py-2.5 text-sm font-medium text-black">Find jobs</Link>
            <Link href="/signup" className="rounded-full bg-surface px-5 py-2.5 text-sm font-medium text-black">Create workspace</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
