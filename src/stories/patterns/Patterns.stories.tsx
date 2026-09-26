import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Briefcase } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Card, SectionHeader } from '@/components/ui/primitives';

const meta = {
  title: 'Patterns/App',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A focal orb, a title, one line, at most one action — no dashed box. Lines rise in 40ms apart. */
export const EmptyStateStory: Story = {
  name: 'Empty state',
  render: () => (
    <EmptyState
      icon={Briefcase}
      title="No postings yet"
      description="Draft a role, publish it, and applicants flow straight into your pipeline."
      action={<Button variant="primary">New posting</Button>}
    />
  ),
};

/** 20/28 title at 500, an ink-2 subtitle, actions on the right at the md height. */
export const PageHeaderStory: Story = {
  name: 'Page header',
  render: () => (
    <PageHeader
      title="Pipeline"
      subtitle="All active candidates"
      actions={
        <>
          <Button>Posting</Button>
          <Button variant="primary">Add candidate</Button>
        </>
      }
    />
  ),
};

/** Sections open with a quiet sentence-case label above a white card. */
export const SectionStory: Story = {
  name: 'Section header',
  render: () => (
    <div className="max-w-xl">
      <SectionHeader title="Scorecards" action={<Button size="xs" variant="ghost">Add feedback</Button>} />
      <Card className="p-5 text-sm text-ink-2">No feedback yet.</Card>
    </div>
  ),
};

/** Copy swaps its icon to a check and its label to "Copied", then settles back. */
export const CopyStory: Story = {
  name: 'Copy button',
  render: () => (
    <div className="flex items-center gap-2">
      <code className="rounded-field bg-recessed px-2 py-1 font-mono text-xs">/careers/demo</code>
      <CopyButton text="https://source.example/careers/demo" size="sm" />
    </div>
  ),
};
