import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Dropdown } from '@/components/dropdown';
import { Card } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Dropdown',
  parameters: {
    docs: {
      description: {
        component:
          'Filters and quick actions: a pill trigger in sentence case over a floating surface menu that grows from its trigger (250ms in, 150ms out). `md` matches fields and buttons in a toolbar; `compact` sits in rows. Inside a white surface, pass `onSurface`.',
      },
    },
  },
} satisfies Meta;

export default meta;

export const Filter: StoryObj = {
  render: () => {
    const [v, setV] = useState('');
    return (
      <Dropdown
        label="Posting"
        value={v}
        onSelect={setV}
        allLabel="All postings"
        options={[
          { value: 'fe', label: 'Founding engineer' },
          { value: 'pd', label: 'Senior product designer' },
        ]}
      />
    );
  },
};

export const InATableRow: StoryObj = {
  render: () => (
    <Card className="p-4">
      <Dropdown
        compact
        onSurface
        label="Phone screen"
        showSelectedInTrigger={false}
        onSelect={() => {}}
        options={[
          { value: 'n', label: 'New applicant' },
          { value: 'o', label: 'On-site' },
        ]}
      />
    </Card>
  ),
};
