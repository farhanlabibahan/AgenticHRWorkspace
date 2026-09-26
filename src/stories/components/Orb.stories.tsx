import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Avatar, Orb } from '@/components/ui/orb';
import { ORB_PALETTES } from '@/components/ui/orb-palettes';

const meta = {
  title: 'Components/Orb & avatar',
  component: Orb,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "The one place color lives: Orbkit's SHDR-14, a lit plasma dome dithered through an 8×8 Bayer matrix. Seeded from an entity id. At 64px and up it's the live WebGL shader; below that, a still dithered frame on a 2D canvas, so long lists never exhaust the browser's ~16 WebGL contexts.",
      },
    },
  },
  args: { seed: 'Founding engineer', size: 160, animate: true },
  argTypes: {
    palette: { control: 'select', options: [undefined, ...Object.keys(ORB_PALETTES)] },
    size: { control: { type: 'range', min: 16, max: 360, step: 4 } },
  },
} satisfies Meta<typeof Orb>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Palettes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-8">
      {(Object.keys(ORB_PALETTES) as (keyof typeof ORB_PALETTES)[]).map((p) => (
        <div key={p} className="flex flex-col items-center gap-2">
          <Orb palette={p} size={88} />
          <span className="text-xs text-ink-2">{p}</span>
        </div>
      ))}
    </div>
  ),
};

export const Avatars: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      {[24, 32, 40, 56].map((s) => (
        <div key={s} className="flex flex-col items-center gap-2">
          <Avatar name="Maya Chen" size={s} />
          <span className="text-xs text-ink-2">{s}</span>
        </div>
      ))}
      <div className="t-stack flex -space-x-2">
        {['Maya Chen', 'Jordan Alvarez', 'Priya Nair', 'Sam Whitfield'].map((n) => (
          <Avatar key={n} name={n} size={36} className="ring-2 ring-canvas" />
        ))}
      </div>
    </div>
  ),
};
