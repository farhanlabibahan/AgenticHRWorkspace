import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Badge, Card, SectionHeader, StatusDot } from '@/components/ui/primitives';
import { Avatar, Orb } from '@/components/ui/orb';
import { Button } from '@/components/ui/button';

const meta = {
  title: 'Components/Card',
  component: Card,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A raised surface: white, 12px radius, no border, no shadow. Interactive cards lift on hover. Lists are one card with hairline dividers between rows — never a stack of bordered boxes.',
      },
    },
  },
  args: { interactive: true, children: null },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PostingCards: Story = {
  render: () => (
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
  ),
};

export const List: Story = {
  render: () => (
    <div className="max-w-2xl">
      <SectionHeader title="Recent candidates" />
      <Card className="divide-y divide-line">
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
              Advance
            </Button>
          </div>
        ))}
      </Card>
    </div>
  ),
};
