import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Segmented } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Segmented',
  parameters: {
    docs: {
      description: {
        component:
          'Two to four views of the same data. A recessed pill track; the white thumb slides to the active option (transitions.dev "tabs sliding": 250ms, smooth-out).',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [v, setV] = useState<'active' | 'archived'>('active');
    return (
      <Segmented
        value={v}
        onChange={setV}
        items={[
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' },
        ]}
      />
    );
  },
};

export const FourOptions: Story = {
  render: () => {
    const [v, setV] = useState<'r' | 'i' | 'm' | 'c'>('r');
    return (
      <Segmented
        value={v}
        onChange={setV}
        items={[
          { value: 'r', label: 'Recruiters' },
          { value: 'i', label: 'Interviewers' },
          { value: 'm', label: 'Hiring managers' },
          { value: 'c', label: 'Clients' },
        ]}
      />
    );
  },
};
