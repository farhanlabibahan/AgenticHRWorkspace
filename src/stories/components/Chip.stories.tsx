import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Chip } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Chip',
  component: Chip,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Filter chips are white pills. The selected chip gets the 1px gray stroke and full ink — never an ink fill or a heavy ring. Inside a white surface, pass `onSurface` so unselected chips sit on muted.',
      },
    },
  },
  args: { children: 'Design', selected: true },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const FilterRow: Story = {
  render: () => {
    const [value, setValue] = useState('Design');
    return (
      <div className="flex flex-wrap gap-2">
        {['Design', 'Engineering', 'Sales', 'Remote', 'Referred'].map((c) => (
          <Chip key={c} selected={value === c} onClick={() => setValue(c)}>
            {c}
          </Chip>
        ))}
      </div>
    );
  },
};
