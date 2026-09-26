import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { useDialKitController, type TransitionConfig } from 'dialkit';
import { Button } from '@/components/ui/button';
import { Badge, Card, Chip, Segmented, StatusDot } from '@/components/ui/primitives';
import { Switch } from '@/components/switch';
import { DitherBar } from '@/components/ui/dither';
import { inputClass } from '@/components/form-controls';
import { changed, copyText, Dials, prompt, transitionCss, useCopied, useLatest } from './dials';

/**
 * Tune the whole system at once. Every dial overrides a real @theme token
 * on this frame only (Tailwind v4 utilities read the variables), so what
 * you see is the app's own components under the new values.
 */

const COLORS = {
  canvas: '#f5f4f2',
  surface: '#ffffff',
  recessed: '#edece9',
  muted: '#f2f1ef',
  ink: '#0a0a0a',
  'ink-2': '#6b6a67',
  'ink-3': '#9b9a96',
};
const RADII = { field: 8, card: 12, dialog: 16, media: 24 };
const TYPE = { sm: 13, base: 14, md: 16, '2xl': 24, '4xl': 44 };
const MOTION = {
  fast: { type: 'easing' as const, duration: 0.25, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  quick: { type: 'easing' as const, duration: 0.15, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
};

function TokensPlayground() {
  const [replay, setReplay] = useState(0);
  const { flash, note } = useCopied();

  const dial = useDialKitController(
    'Tokens',
    {
      Color: { ...COLORS },
      Radius: {
        field: [RADII.field, 0, 24, 1],
        card: [RADII.card, 0, 32, 1],
        dialog: [RADII.dialog, 0, 40, 1],
        media: [RADII.media, 0, 48, 1],
        _collapsed: true,
      },
      Type: {
        sm: [TYPE.sm, 11, 16, 0.5],
        base: [TYPE.base, 12, 18, 0.5],
        md: [TYPE.md, 13, 20, 0.5],
        '2xl': [TYPE['2xl'], 18, 36, 1],
        '4xl': [TYPE['4xl'], 28, 72, 1],
        _collapsed: true,
      },
      Motion: {
        fast: MOTION.fast,
        quick: MOTION.quick,
        replay: { type: 'action', label: 'Replay motion' },
        _collapsed: true,
      },
      reset: { type: 'action', label: 'Reset to defaults' },
      copy: { type: 'action', label: 'Copy for Claude' },
    },
    {
      id: 'playground-tokens',
      persist: true,
      onAction: (path) => {
        if (path === 'reset') return dialRef.current.resetValues();
        if (path.endsWith('replay')) setReplay((n) => n + 1);
        if (path === 'copy') {
          copyText(tokensPrompt(latest.current));
          flash();
        }
      },
    },
  );
  const dialRef = useLatest(dial);
  const values = dial.values;
  const latest = useLatest(values);

  const fast = transitionCss(values.Motion.fast);
  const quick = transitionCss(values.Motion.quick);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(values.Color)) vars[`--color-${k}`] = v;
  for (const [k, v] of Object.entries(values.Radius)) vars[`--radius-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(values.Type)) vars[`--text-${k}`] = `${v}px`;
  vars['--duration-fast'] = fast.duration;
  vars['--duration-quick'] = quick.duration;
  if (values.Motion.fast.type === 'easing') vars['--ease-smooth'] = fast.ease;

  return (
    <div style={vars as React.CSSProperties} className="min-h-screen bg-canvas p-8 text-ink lg:pr-[340px]">
      <Dials />
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <p className="text-sm text-ink-2">Playground</p>
          <h1 className="mt-1 text-4xl text-ink">Tune the tokens</h1>
          <p className="mt-2 max-w-lg text-md text-ink-2">
            Every dial overrides a real token on this frame. When it looks right, press Copy for
            Claude and paste the prompt into Claude.
          </p>
        </div>

        <div key={replay} className="grid gap-4 md:grid-cols-2">
          <Card className="t-rise flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl text-ink">Senior Designer</h2>
              <Badge tone="positive">Open</Badge>
            </div>
            <input className={inputClass} placeholder="Search candidates" />
            <div className="flex flex-wrap gap-2">
              <Chip selected>All stages</Chip>
              <Chip>New applicant</Chip>
              <Chip>On-site</Chip>
            </div>
            <DitherBar value={64} max={128} />
            <div className="flex gap-2">
              <Button variant="primary">Advance</Button>
              <Button variant="tonal">Snooze</Button>
              <Button variant="ghost">Archive</Button>
            </div>
          </Card>

          <div className="t-rise flex flex-col gap-4" style={{ '--i': 2 } as React.CSSProperties}>
            <MotionDemo />
            <div className="rounded-media bg-recessed p-5">
              <p className="text-sm text-ink-2">Media radius</p>
              <p className="mt-1 text-base text-ink">Showcase frames and marketing art.</p>
            </div>
            <div className="rounded-dialog bg-surface p-5 shadow-float">
              <p className="flex items-center gap-2 text-sm text-ink">
                <StatusDot tone="critical" /> Dialog radius, float shadow
              </p>
            </div>
          </div>
        </div>
        {note}
      </div>
    </div>
  );
}

/** The Segmented thumb and a Switch: both ride --duration-fast / --ease-smooth. */
function MotionDemo() {
  const [tab, setTab] = useState<'day' | 'week' | 'month'>('week');
  const [on, setOn] = useState(true);
  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <Segmented
        value={tab}
        onChange={setTab}
        items={[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
        ]}
      />
      <Switch checked={on} onChange={setOn} label="Notify" />
    </Card>
  );
}

type Values = {
  Color: typeof COLORS;
  Radius: typeof RADII;
  Type: typeof TYPE;
  Motion: { fast: TransitionConfig; quick: TransitionConfig };
};

function tokensPrompt(v: Values) {
  const lines: string[] = [];
  const root: string[] = [];
  for (const k of changed(v.Color, COLORS)) lines.push(`  --color-${k}: ${v.Color[k]};`);
  for (const k of changed(v.Radius, RADII)) lines.push(`  --radius-${k}: ${v.Radius[k]}px;`);
  for (const k of changed(v.Type, TYPE)) lines.push(`  --text-${k}: ${v.Type[k]}px;`);
  for (const k of ['fast', 'quick'] as const) {
    if (JSON.stringify(v.Motion[k]) === JSON.stringify(MOTION[k])) continue;
    const t = transitionCss(v.Motion[k]);
    root.push(`  --duration-${k}: ${t.duration};`);
    if (k === 'fast') lines.push(`  --ease-smooth: ${t.ease};`);
  }
  if (!lines.length && !root.length) return 'No token changes yet — move a dial first.';

  const css = [
    lines.length ? `@theme {\n${lines.join('\n')}\n}` : '',
    root.length ? `:root {\n${root.join('\n')}\n}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return prompt(
    'Update the Source design tokens in src/app/globals.css to these values (tuned in the Storybook token playground):',
    `\`\`\`css
${css}
\`\`\`

Then:
- If a text size changed, keep its line-height on the 4px grid.
- Update the matching values in docs/09-design-system.md so the doc and the code agree.
- Search for hard-coded copies of the old values (e.g. rounded-[12px], duration-[250ms]) and move them to the token.
- Run \`npx tsc --noEmit\` and \`npx storybook build\`.`,
  );
}

const meta = {
  title: 'Playground/Tokens',
  component: TokensPlayground,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TokensPlayground>;

export default meta;
export const Tokens: StoryObj<typeof meta> = {};
