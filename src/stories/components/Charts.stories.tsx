import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { DitherBar, DitherColumns, DitherRing } from '@/components/ui/dither';
import { Card } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Charts',
  component: DitherBar,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Dithered, ink-only charts: a tight grid of dots (2px in bars, 3px in columns and rings) filled by an 8×8 Bayer threshold over a faint dotted track. They draw once, ease in when scrolled into view, tween from old values on change, and draw the final frame immediately under reduced motion.',
      },
    },
  },
  args: { value: 24, max: 40 },
  argTypes: { value: { control: { type: 'range', min: 0, max: 40 } } },
} satisfies Meta<typeof DitherBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bar: Story = {
  render: (args) => (
    <Card className="max-w-xl p-5">
      <DitherBar {...args} />
    </Card>
  ),
};

export const Funnel: Story = {
  render: () => (
    <Card className="max-w-xl p-5">
      {(
        [
          ['New applicant', 128],
          ['Phone screen', 64],
          ['On-site', 22],
          ['Offer', 9],
          ['Hired', 7],
        ] as const
      ).map(([name, n]) => (
        <div key={name} className="grid grid-cols-[112px_1fr_32px] items-center gap-3 py-1.5">
          <span className="truncate text-sm">{name}</span>
          <DitherBar value={n} max={128} />
          <span className="text-right text-xs text-ink-2 tabular-nums">{n}</span>
        </div>
      ))}
    </Card>
  ),
};

export const Columns: Story = {
  render: () => (
    <Card className="max-w-xl p-5">
      <DitherColumns
        height={120}
        unit="d"
        data={[
          { label: 'New applicant', value: 3 },
          { label: 'Phone screen', value: 6 },
          { label: 'On-site', value: 11 },
          { label: 'Offer', value: 4 },
        ]}
      />
    </Card>
  ),
};

export const Ring: Story = {
  render: () => (
    <Card className="flex max-w-md items-center gap-5 p-5">
      <DitherRing value={62} size={88} thickness={12}>
        <span className="text-md font-medium tabular-nums">62%</span>
      </DitherRing>
      <div>
        <p className="text-md font-medium">Offer acceptance</p>
        <p className="text-sm text-ink-2">5 of 8 offers accepted this quarter</p>
      </div>
    </Card>
  ),
};
