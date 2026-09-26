import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Checkbox } from '@/components/ui/checkbox';

const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A real checkbox underneath — forms, labels, and keyboards work unchanged — with a check that draws on (transitions.dev "checkbox check"). Without `label` it renders a span, so it can sit inside an existing label.',
      },
    },
  },
  args: { label: 'Send the offer letter', defaultChecked: true },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

