import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Bot } from '@/components/ui/bot';
import { StreamingText, TextSwap, ThinkingStates } from '@/components/ui/motion';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';

const meta = {
  title: 'Components/Assistant',
  component: Bot,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "The assistant's one face (bot-avatars). Its state must be true: `idle` when ready, `working` while a request is in flight (pair with ThinkingStates), `sleeping` when AI isn't configured. Wherever the UI says Ask AI, the bot stands in for the icon.",
      },
    },
  },
  args: { state: 'idle', size: 72 },
  argTypes: { state: { control: 'inline-radio', options: ['idle', 'working', 'sleeping'] } },
} satisfies Meta<typeof Bot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The full Ask AI moment: bot in the button, thinking lines, then a streamed answer. */
export const AskAI: Story = {
  render: () => {
    const [phase, setPhase] = useState<'idle' | 'working' | 'done'>('idle');
    return (
      <div className="max-w-xl">
        <Button
          variant="secondary"
          onClick={() => {
            setPhase('working');
            setTimeout(() => setPhase('done'), 3600);
          }}
        >
          <Bot state={phase === 'working' ? 'working' : 'idle'} size={20} />
          <TextSwap>{phase === 'working' ? 'Thinking…' : 'Ask AI'}</TextSwap>
        </Button>
        <Card className="mt-3 min-h-20 p-5 text-sm">
          {phase === 'working' ? (
            <ThinkingStates lines={['Reading interview transcripts…', 'Searching resumes and notes…', 'Citing candidates…']} />
          ) : phase === 'done' ? (
            <StreamingText text="Two strong matches: Jordan Alvarez built and ran a token-based design system, and Maya Chen maintains one used by 40 engineers." />
          ) : (
            <span className="text-ink-2">Press Ask AI.</span>
          )}
        </Card>
      </div>
    );
  },
};
