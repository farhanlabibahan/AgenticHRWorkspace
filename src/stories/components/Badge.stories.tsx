import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Badge, StatusDot } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'An xs pill: muted on a surface, white on the canvas (`onCanvas`). A `tone` adds a 6px status dot; the text stays ink-2. Never outlined, never mono. `wrap` lets long text (AI strengths) wrap.',
      },
    },
  },
  args: { children: 'Published', tone: 'positive', onCanvas: true },
  argTypes: {
    tone: { control: 'inline-radio', options: [undefined, 'neutral', 'positive', 'caution', 'critical', 'info'] },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge onCanvas>7 candidates</Badge>
      <Badge onCanvas tone="positive">Published</Badge>
      <Badge onCanvas tone="caution">Stalled 9d</Badge>
      <Badge onCanvas tone="critical">Rejected</Badge>
      <Badge onCanvas tone="info">Internal</Badge>
      <span className="flex items-center gap-2 text-xs text-ink-2">
        <StatusDot tone="caution" /> dot alone, in a row
      </span>
    </div>
  ),
};

export const Wrapping: Story = {
  render: () => (
    <div className="max-w-xs">
      <Badge wrap tone="positive" className="text-ink">
        Led a design-system migration end to end, including the component audit
      </Badge>
    </div>
  ),
};
