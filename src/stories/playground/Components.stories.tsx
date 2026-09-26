import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useDialKitController } from 'dialkit';
import { Plus } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { Orb } from '@/components/ui/orb';
import { ORB_PALETTES, type OrbPalette } from '@/components/ui/orb-palettes';
import { DitherBar, DitherColumns, DitherRing } from '@/components/ui/dither';
import { copyText, Dials, prompt, useCopied, useLatest } from './dials';

/**
 * One component at a time, on dials. "Copy for Claude" hands over either
 * the JSX to use (props only) or, when a dial changed the component itself,
 * the edit to make in its source file.
 */

function Frame({ children, note }: { children: React.ReactNode; note: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas p-8 lg:pr-[340px]">
      <Dials />
      {children}
      {note}
    </div>
  );
}

/* ---------- Button ---------- */

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'tonal', 'ghost', 'critical'];
const SIZES: ButtonSize[] = ['xs', 'sm', 'md', 'lg'];
/** Current horizontal padding per size, from button.tsx. */
const PAD: Record<ButtonSize, number> = { xs: 10, sm: 12, md: 16, lg: 20 };

function ButtonPlayground() {
  const { flash, note } = useCopied();
  const dial = useDialKitController(
    'Button',
    {
      variant: { type: 'select', options: VARIANTS, default: 'primary' },
      size: { type: 'select', options: SIZES, default: 'md' },
      label: 'Advance',
      icon: false,
      disabled: false,
      Component: { padding: [0, -8, 12, 1], weight: [500, 400, 700, 100], _collapsed: true },
      reset: { type: 'action', label: 'Reset to defaults' },
      copy: { type: 'action', label: 'Copy for Claude' },
    },
    {
      id: 'playground-button',
      persist: true,
      onAction: (path) => {
        if (path === 'reset') return dialRef.current.resetValues();
        if (path !== 'copy') return;
        copyText(buttonPrompt(latest.current));
        flash();
      },
    },
  );
  const dialRef = useLatest(dial);
  const values = dial.values;
  const latest = useLatest(values);
  const size = values.size as ButtonSize;

  return (
    <Frame note={note}>
      <div className="flex items-center gap-3 rounded-card bg-surface p-8">
        <Button
          variant={values.variant as ButtonVariant}
          size={size}
          disabled={values.disabled}
          style={{
            paddingInline: PAD[size] + values.Component.padding,
            fontWeight: values.Component.weight,
          }}
        >
          {values.icon ? <Plus /> : null}
          {values.label}
        </Button>
      </div>
    </Frame>
  );
}

function buttonPrompt(v: {
  variant: string;
  size: string;
  label: string;
  icon: boolean;
  disabled: boolean;
  Component: { padding: number; weight: number };
}) {
  const props = [
    v.variant !== 'secondary' && `variant="${v.variant}"`,
    v.size !== 'md' && `size="${v.size}"`,
    v.disabled && 'disabled',
  ].filter(Boolean);
  const jsx = `<Button${props.length ? ' ' + props.join(' ') : ''}>
  ${v.icon ? '<Plus /> ' : ''}${v.label}
</Button>`;
  const size = v.size as ButtonSize;
  const edits: string[] = [];
  if (v.Component.padding !== 0)
    edits.push(`- The "${size}" size's horizontal padding: ${PAD[size]}px → ${PAD[size] + v.Component.padding}px (the sizes map in src/components/ui/button.tsx).`);
  if (v.Component.weight !== 500)
    edits.push(`- Button text weight: 500 → ${v.Component.weight} (font-medium in the base class). Check it still reads next to the 44px fields.`);

  if (!edits.length)
    return prompt('Use this button (from src/components/ui/button.tsx):', `\`\`\`tsx\n${jsx}\n\`\`\``);
  return prompt(
    'Change the Button component in src/components/ui/button.tsx:',
    `${edits.join('\n')}

It was tuned on this button:

\`\`\`tsx
${jsx}
\`\`\`

Update docs/09-design-system.md §6 (buttons) to match, and check the Button stories still line up with fields and chips at the same height tier.`,
  );
}

/* ---------- Orb ---------- */

const PALETTES = Object.keys(ORB_PALETTES) as OrbPalette[];

function OrbPlayground() {
  const { flash, note } = useCopied();
  const dial = useDialKitController(
    'Orb',
    {
      palette: { type: 'select', options: PALETTES, default: PALETTES[0] },
      size: [160, 16, 360, 4],
      animate: true,
      soft: false,
      reset: { type: 'action', label: 'Reset to defaults' },
      copy: { type: 'action', label: 'Copy for Claude' },
    },
    {
      id: 'playground-orb',
      persist: true,
      onAction: (path) => {
        if (path === 'reset') return dialRef.current.resetValues();
        if (path !== 'copy') return;
        const v = latest.current;
        const jsx = `<Orb palette="${v.palette}" size={${v.size}}${v.animate ? ' animate' : ''}${v.soft ? ' soft' : ''} />`;
        copyText(
          prompt(
            'Use this orb (src/components/ui/orb.tsx):',
            `\`\`\`tsx\n${jsx}\n\`\`\`\n\nThe live shader only runs at 64px and up with animate and not soft; smaller or soft orbs are a still dithered frame.`,
          ),
        );
        flash();
      },
    },
  );
  const dialRef = useLatest(dial);
  const values = dial.values;
  const latest = useLatest(values);
  return (
    <Frame note={note}>
      <Orb
        palette={values.palette as OrbPalette}
        size={values.size}
        animate={values.animate}
        soft={values.soft}
      />
    </Frame>
  );
}

/* ---------- Charts ---------- */

const DAYS = [
  { label: 'Screen', value: 4 },
  { label: 'On-site', value: 9 },
  { label: 'Offer', value: 3 },
  { label: 'Hired', value: 6 },
];

function ChartsPlayground() {
  const { flash, note } = useCopied();
  const dial = useDialKitController(
    'Charts',
    {
      Columns: { height: [120, 48, 240, 4], unit: 'd' },
      Bar: { value: [64, 0, 128, 1], height: [8, 4, 24, 1] },
      Ring: { value: [72, 0, 100, 1], size: [64, 32, 160, 4], thickness: [10, 2, 32, 1] },
      reset: { type: 'action', label: 'Reset to defaults' },
      copy: { type: 'action', label: 'Copy for Claude' },
    },
    {
      id: 'playground-charts',
      persist: true,
      onAction: (path) => {
        if (path === 'reset') return dialRef.current.resetValues();
        if (path !== 'copy') return;
        const v = latest.current;
        copyText(
          prompt(
            'Use these dither charts (src/components/ui/dither.tsx):',
            `\`\`\`tsx
<DitherColumns data={data} height={${v.Columns.height}} unit="${v.Columns.unit}" />
<DitherBar value={${v.Bar.value}} max={128} height={${v.Bar.height}} />
<DitherRing value={${v.Ring.value}} size={${v.Ring.size}} thickness={${v.Ring.thickness}} />
\`\`\``,
          ),
        );
        flash();
      },
    },
  );
  const dialRef = useLatest(dial);
  const values = dial.values;
  const latest = useLatest(values);
  return (
    <Frame note={note}>
      <div className="flex w-full max-w-md flex-col gap-6 rounded-card bg-surface p-6">
        <DitherColumns data={DAYS} height={values.Columns.height} unit={values.Columns.unit} />
        <DitherBar value={values.Bar.value} max={128} height={values.Bar.height} />
        <DitherRing value={values.Ring.value} size={values.Ring.size} thickness={values.Ring.thickness} />
      </div>
    </Frame>
  );
}

const meta = {
  title: 'Playground/Components',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ButtonDials: Story = { name: 'Button', render: () => <ButtonPlayground /> };
export const OrbDials: Story = { name: 'Orb', render: () => <OrbPlayground /> };
export const ChartsDials: Story = { name: 'Charts', render: () => <ChartsPlayground /> };
