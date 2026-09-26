import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';
import { Row } from '../kit';

const meta = {
  title: 'Components/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Every button is a pill. One `primary` (ink) per view; `secondary` (white) on the canvas, `tonal` inside a white surface, `ghost` for low-emphasis actions, `critical` only to confirm something destructive. Heights are shared with fields and chips: xs 24 · sm 32 · md 36 · lg 44.',
      },
    },
  },
  args: { children: 'Add candidate', variant: 'primary', size: 'md' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'tonal', 'ghost', 'critical'] },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    icon: { control: 'boolean', description: 'Icon-only circle at the same height' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every variant at every size — the spec sheet. */
export const AllVariants: Story = {
  render: () => (
    <div>
      {(['primary', 'secondary', 'tonal', 'ghost', 'critical'] as const).map((v) => (
        <Row key={v} label={v}>
          {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
            <Button key={s} variant={v} size={s}>
              <Plus /> {s}
            </Button>
          ))}
          <Button variant={v} icon aria-label="Add">
            <Plus />
          </Button>
        </Row>
      ))}
    </div>
  ),
};

/** Inside a white card, secondary actions go tonal so they don't disappear. */
export const OnASurface: Story = {
  render: () => (
    <Card className="flex items-center gap-3 p-5">
      <Button variant="primary">Save</Button>
      <Button variant="tonal">Preview</Button>
      <Button variant="ghost">Cancel</Button>
    </Card>
  ),
};
