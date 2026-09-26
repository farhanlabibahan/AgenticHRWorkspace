import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Switch } from '@/components/switch';

const meta = {
  title: 'Components/Switch',
  parameters: {
    docs: {
      description: {
        component:
          'A recessed track that fills with ink when on. The thumb overshoots a pixel and settles (transitions.dev "toggle") — only after a real change, never on page load. Pair it with a quiet caption that names the state.',
      },
    },
  },
} satisfies Meta;

export default meta;

export const Default: StoryObj = {
  render: () => {
    const [on, setOn] = useState(true);
    return (
      <div className="flex items-center gap-3 text-sm">
        <Switch checked={on} onChange={setOn} label="Independent scorecards" />
        <span className="text-ink-2">{on ? 'Hidden until submitted' : 'Open scorecards'}</span>
      </div>
    );
  },
};
