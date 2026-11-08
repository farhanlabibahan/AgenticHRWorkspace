import type { Metadata } from 'next';
import { ArrowLeft, Bookmark, Briefcase, Heart, Home, Play, Plus, Search, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Orb, Avatar } from '@/components/ui/orb';
import { ORB_PALETTES, type OrbPalette } from '@/components/ui/orb-palettes';
import { Badge, Card, Chip, SectionHeader, Segmented, StatusDot } from '@/components/ui/primitives';
import { inputClass, inputLgClass, textareaClass, Field, badge, noAutofill } from '@/components/form-controls';
import { EmptyState } from '@/components/empty-state';
import { BotLab, ChartLab, MotionLab } from './demos';

export const metadata: Metadata = { title: 'Design system · Orqestra', robots: { index: false } };

/**
 * Living specimen for docs/09-design-system.md. Every token and primitive
 * renders here; the two phone frames rebuild the reference screens from
 * system parts only — if they drift from the reference, the rules are wrong.
 */

const COLORS: [string, string, string][] = [
  ['canvas', 'bg-canvas', 'Page'],
  ['surface', 'bg-surface', 'Raised'],
  ['recessed', 'bg-recessed', 'Fields, tracks'],
  ['muted', 'bg-muted', 'Fills on surface'],
  ['ink', 'bg-ink', 'Text, primary'],
  ['ink-2', 'bg-ink-2', 'Secondary text'],
  ['ink-3', 'bg-ink-3', 'Placeholder'],
];

const STATUS = [
  ['positive', 'bg-positive'],
  ['caution', 'bg-caution'],
  ['critical', 'bg-critical'],
  ['info', 'bg-info'],
] as const;

const TYPE: [string, string, string][] = [
  ['6xl', 'text-6xl', '72 / 72 · 400'],
  ['5xl', 'text-5xl', '56 / 60 · 400'],
  ['4xl', 'text-4xl', '44 / 48 · 400'],
  ['3xl', 'text-3xl', '32 / 36 · 400'],
  ['2xl', 'text-2xl', '24 / 32 · 400'],
  ['xl', 'text-xl font-medium', '20 / 28 · 500'],
  ['lg', 'text-lg font-medium', '18 / 24 · 500'],
  ['md', 'text-md', '16 / 24 · 400'],
  ['base', 'text-base', '14 / 20 · 400'],
  ['sm', 'text-sm', '13 / 20 · 400'],
  ['xs', 'text-xs', '12 / 16 · 400'],
  ['2xs', 'text-2xs', '11 / 16 · 400'],
];

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;
const VARIANTS = ['primary', 'secondary', 'tonal', 'ghost', 'critical'] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="border-t border-line py-12">
      <h2 className="mb-6 text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-[844px] w-[390px] shrink-0 flex-col overflow-hidden rounded-[44px] bg-canvas shadow-float">
      {children}
    </div>
  );
}

function PhoneNav() {
  return (
    <div className="absolute inset-x-0 bottom-6 flex justify-center">
      <div className="flex items-center gap-1 rounded-full bg-surface p-1.5 shadow-float">
        {[
          [Home, 'Home'],
          [Heart, 'Sessions'],
          [BarChart3, 'Progress'],
        ].map(([Icon, label], i) => {
          const I = Icon as typeof Home;
          return (
            <span
              key={label as string}
              className={`flex h-12 w-20 flex-col items-center justify-center gap-0.5 rounded-full text-2xs ${i === 0 ? 'text-ink' : 'text-ink-2'}`}
            >
              <I size={18} strokeWidth={1.75} />
              {label as string}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function SystemPage() {
  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-32 pt-16 md:px-8">
      <header className="mb-12">
        <p className="text-xs font-medium text-ink-2">Orqestra · docs/09</p>
        <h1 className="mt-3 text-4xl md:text-5xl">Design system</h1>
        <p className="mt-4 max-w-prose text-md text-ink-2">
          Value, not lines. The interface stays grey and the content carries the color. Pills are
          for pressing, soft rectangles are for typing into, and rounded rectangles hold content.
        </p>
      </header>

      {/* Reference rebuild */}
      <Section id="reference" title="Reference, rebuilt from system parts">
        <div className="no-scrollbar -mx-4 flex gap-10 overflow-x-auto px-4 pb-8 pt-2">
          <Phone>
            <div className="flex items-center justify-between px-4 pt-14">
              <Button icon size="md" aria-label="Back">
                <ArrowLeft />
              </Button>
              <Button icon size="md" aria-label="Save">
                <Bookmark />
              </Button>
            </div>
            <div className="flex flex-1 flex-col items-center px-8 pt-16">
              <Orb palette="ember" size={272} animate>
                <span className="flex flex-col items-center gap-2 text-center">
                  <Badge className="bg-white/35 text-ink backdrop-blur-sm">12 min</Badge>
                  <span className="text-sm font-medium text-ink">Final round</span>
                  <span className="flex size-6 items-center justify-center rounded-full bg-white/35 backdrop-blur-sm">
                    <Play size={10} fill="currentColor" />
                  </span>
                </span>
              </Orb>
              <h2 className="mt-12 text-xl font-medium">Maya Chen</h2>
              <p className="mt-1 text-sm text-ink-2">Senior Product Designer · Figment</p>
              <Button variant="primary" size="lg" className="mt-8 w-full">
                Start interview
              </Button>
            </div>
            <PhoneNav />
          </Phone>

          <Phone>
            <div className="flex items-center justify-between px-4 pt-14">
              <Avatar name="Adam P" size={36} />
              <Button icon size="md" aria-label="Search">
                <Search />
              </Button>
            </div>
            <div className="px-4 pt-6">
              <h2 className="text-xl font-medium">Explore</h2>
              <input {...noAutofill} className={`${inputLgClass} mt-4`} placeholder="Who are you looking for?" />
              <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
                {['Design', 'Engineering', 'Sales', 'Remote', 'Referred', 'Stalled'].map((c, i) => (
                  <Chip key={c} selected={i === 0}>
                    {c}
                  </Chip>
                ))}
              </div>
              <SectionHeader title="Open roles" className="mt-10" />
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Founding engineer', 23, 'lavender'],
                  ['Design lead', 57, 'iris'],
                  ['Account exec', 76, 'prism'],
                  ['Data platform', 120, 'glacier'],
                ].map(([t, n, p]) => (
                  <Card key={t as string} interactive className="flex flex-col items-center px-4 pb-4 pt-6">
                    <Orb palette={p as OrbPalette} size={56} />
                    <span className="mt-4 text-sm">{t}</span>
                    <Badge className="mt-2">{n}</Badge>
                  </Card>
                ))}
              </div>
              <div className="mt-4 flex justify-center">
                <Button size="sm">See more</Button>
              </div>
            </div>
            <PhoneNav />
          </Phone>
        </div>
      </Section>

      <Section id="color" title="Color">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {COLORS.map(([name, cls, use]) => (
            <div key={name}>
              <div className={`h-20 rounded-card ${cls} ${name === 'canvas' ? 'ring-1 ring-line ring-inset' : ''}`} />
              <p className="mt-2 text-sm font-medium">{name}</p>
              <p className="text-xs text-ink-2">{use}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-6">
          {STATUS.map(([name, cls]) => (
            <span key={name} className="flex items-center gap-2 text-sm">
              <span className={`size-1.5 rounded-full ${cls}`} />
              {name}
            </span>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-end gap-6">
          {(Object.keys(ORB_PALETTES) as OrbPalette[]).map((p) => (
            <div key={p} className="flex flex-col items-center gap-3">
              <Orb palette={p} size={88} />
              <span className="text-xs text-ink-2">{p}</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-3">
            <div className="t-stack flex -space-x-2">
              {['Maya Chen', 'Jordan Alvarez', 'Priya Nair', 'Sam Whitfield'].map((n) => (
                <Avatar key={n} name={n} size={36} className="ring-2 ring-canvas" />
              ))}
            </div>
            <span className="text-xs text-ink-2">avatars (soft)</span>
          </div>
        </div>
      </Section>

      <Section id="type" title="Type">
        <div className="flex flex-col">
          {TYPE.map(([name, cls, spec]) => (
            <div key={name} className="flex items-baseline gap-6 border-b border-line py-3 last:border-0">
              <span className="w-28 shrink-0 text-xs text-ink-2">
                {name} · {spec}
              </span>
              <span className={`${cls} truncate`}>Hiring you actually own</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <div className="flex flex-col gap-5">
          {VARIANTS.map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <span className="w-24 text-xs text-ink-2">{v}</span>
              {SIZES.map((s) => (
                <Button key={s} variant={v} size={s}>
                  <Plus /> {s}
                </Button>
              ))}
              <Button variant={v} icon aria-label="Add">
                <Plus />
              </Button>
            </div>
          ))}
          <Card className="flex flex-wrap items-center gap-3 p-5">
            <span className="w-24 text-xs text-ink-2">on surface</span>
            <Button variant="primary">Save</Button>
            <Button variant="tonal">Preview</Button>
            <Button variant="ghost">Cancel</Button>
          </Card>
        </div>
      </Section>

      <Section id="inputs" title="Fields share the control heights">
        <div className="grid gap-8 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Field label="Full name" hint="As it appears on their resume.">
              <input {...noAutofill} className={inputClass} placeholder="Maya Chen" />
            </Field>
            <Field label="Notes">
              <textarea {...noAutofill} className={textareaClass} rows={3} placeholder="What stood out?" />
            </Field>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <input {...noAutofill} className={inputClass} placeholder="Search name, role, location…" />
              <Button>Filter</Button>
              <Button variant="primary">Add candidate</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip selected>All stages</Chip>
              <Chip>New applicant</Chip>
              <Chip>Phone screen</Chip>
              <Chip>On-site</Chip>
            </div>
            <Segmented
              value="active"
              items={[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge onCanvas>7 candidates</Badge>
              <Badge onCanvas tone="positive">Published</Badge>
              <Badge onCanvas tone="caution">Stalled 9d</Badge>
              <Badge onCanvas tone="critical">Rejected</Badge>
              <span className={`${badge} bg-surface`}>badge (class)</span>
            </div>
          </div>
        </div>
      </Section>

      <Section id="motion" title="Motion — tap each card">
        <MotionLab />
      </Section>

      <Section id="bot" title="Assistant">
        <BotLab />
      </Section>

      <Section id="charts" title="Dithered charts">
        <ChartLab />
      </Section>

      <Section id="patterns" title="Cards, lists, empty">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {['Founding engineer', 'Senior product designer', 'Account executive'].map((t, i) => (
            <Card key={t} interactive className="p-5">
              <div className="flex items-start justify-between">
                <Orb seed={t} size={40} />
                <Badge tone={i === 2 ? 'neutral' : 'positive'}>{i === 2 ? 'Draft' : 'Published'}</Badge>
              </div>
              <h3 className="mt-6 text-md font-medium">{t}</h3>
              <p className="mt-1 text-sm text-ink-2">Remote · {12 + i * 9} candidates</p>
            </Card>
          ))}
        </div>

        <Card className="mt-6 divide-y divide-line">
          {['Maya Chen', 'Jordan Alvarez', 'Priya Nair'].map((n, i) => (
            <div key={n} className="flex h-16 items-center gap-3 px-4">
              <Avatar name={n} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{n}</p>
                <p className="text-xs text-ink-2">Senior Product Designer</p>
              </div>
              <span className="flex items-center gap-2 text-xs text-ink-2">
                <StatusDot tone={i === 0 ? 'caution' : 'neutral'} />
                {i === 0 ? '75d in stage' : `${4 + i}d in stage`}
              </span>
              <Button size="sm" variant="tonal">
                Phone screen
              </Button>
            </div>
          ))}
        </Card>

        <EmptyState icon={Briefcase} title="No postings yet" description="Draft a role, publish it, and applicants flow straight into your pipeline." action={<Button variant="primary">New posting</Button>} />
      </Section>
    </div>
  );
}
