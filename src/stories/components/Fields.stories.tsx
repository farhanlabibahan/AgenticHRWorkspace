import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Search } from 'lucide-react';
import { Field, inputClass, inputLgClass, textareaClass } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';

/** Fields are recessed soft rectangles: no border, a step darker than the canvas; focus lifts them to a surface. */
const meta = {
  title: 'Components/Fields',
  parameters: {
    docs: {
      description: {
        component:
          'Type = soft rectangle. Fields sit recessed, turn white with a gray ring on focus, and share the md/lg control heights. Labels sit above in 13px ink at 500.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Input: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <Field label="Full name" hint="As it appears on their resume.">
        <input className={inputClass} placeholder="Maya Chen" />
      </Field>
      <Field label="Email">
        <input className={inputClass} type="email" placeholder="maya@example.com" />
      </Field>
    </div>
  ),
};

export const Search_: Story = {
  name: 'Search',
  render: () => (
    <label className="relative block max-w-md">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
      <input className={`${inputClass} pl-9`} placeholder="Search name, role, location…" />
    </label>
  ),
};

export const Large: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <Field label="Work email">
        <input className={inputLgClass} placeholder="you@company.com" />
      </Field>
    </div>
  ),
};

export const Textarea: Story = {
  render: () => (
    <Field label="Notes" className="max-w-md">
      <textarea className={textareaClass} rows={4} placeholder="What stood out?" />
    </Field>
  ),
};

export const Select: Story = {
  render: () => (
    <Field label="Stage" className="max-w-md">
      <FormSelect
        placeholder="Pick a stage"
        options={[
          { value: 'new', label: 'New applicant' },
          { value: 'screen', label: 'Phone screen' },
          { value: 'onsite', label: 'On-site' },
        ]}
      />
    </Field>
  ),
};
