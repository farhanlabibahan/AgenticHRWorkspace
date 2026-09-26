'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Bot, type BotState } from '@/components/ui/bot';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { DitherBar, DitherColumns, DitherRing } from '@/components/ui/dither';
import {
  Collapse,
  NumberPop,
  StreamingText,
  SuccessCheck,
  TextSwap,
  ThinkingStates,
  useShake,
} from '@/components/ui/motion';
import { Card, Chip, Segmented } from '@/components/ui/primitives';
import { Switch } from '@/components/switch';
import { inputClass, noAutofill } from '@/components/form-controls';

/** Interactive half of the /system specimen: every micro-interaction, live. */

function Demo({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <Card className="flex min-h-36 flex-col justify-between gap-4 p-5">
      <div className="flex flex-1 items-center justify-center">{children}</div>
      <p className="text-xs text-ink-2">{name}</p>
    </Card>
  );
}

export function MotionLab() {
  const [count, setCount] = useState(1454);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [seg, setSeg] = useState<'week' | 'month' | 'quarter'>('month');
  const [chips, setChips] = useState('Design');
  const [on, setOn] = useState(true);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(0);
  const [answer, setAnswer] = useState(0);
  const [fieldRef, shake] = useShake();

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
      <Demo name="Number pop-in">
        <button
          type="button"
          onClick={() => setCount((c) => c + Math.ceil(Math.random() * 120))}
          className="text-3xl"
        >
          <NumberPop value={count} />
        </button>
      </Demo>
      <Demo name="Text swap">
        <Button
          variant="primary"
          onClick={() => {
            setSaving('saving');
            setTimeout(() => setSaving('saved'), 900);
            setTimeout(() => setSaving('idle'), 2200);
          }}
        >
          <TextSwap>{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : 'Save'}</TextSwap>
        </Button>
      </Demo>
      <Demo name="Tabs sliding">
        <Segmented
          value={seg}
          onChange={setSeg}
          items={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'quarter', label: 'Quarter' },
          ]}
        />
      </Demo>
      <Demo name="Selected: 1px stroke">
        <div className="flex flex-wrap justify-center gap-2">
          {['Design', 'Engineering', 'Sales'].map((c) => (
            <Chip key={c} selected={chips === c} onClick={() => setChips(c)}>
              {c}
            </Chip>
          ))}
        </div>
      </Demo>
      <Demo name="Toggle">
        <Switch checked={on} onChange={setOn} label="Demo switch" />
      </Demo>
      <Demo name="Checkbox check">
        <Checkbox label="Send the offer letter" defaultChecked />
      </Demo>
      <Demo name="Icon swap">
        <CopyButton text="https://source.example/careers/demo" label="Copy link" variant="tonal" size="sm" />
      </Demo>
      <Demo name="Success check">
        <button type="button" onClick={() => setDone((d) => d + 1)} className="flex items-center gap-2 text-sm">
          <SuccessCheck key={done} size={24} /> Replay
        </button>
      </Demo>
      <Demo name="Error shake">
        <div ref={fieldRef} className="w-full">
          <input {...noAutofill} className={inputClass} placeholder="Press enter to fail" onKeyDown={(e) => e.key === 'Enter' && shake()} />
        </div>
      </Demo>
      <Demo name="Accordion">
        <div data-open={open} className="w-full">
          <Button variant="tonal" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Show details'}
          </Button>
          <Collapse open={open}>
            <p className="pt-3 text-sm text-ink-2">Scorecards stay hidden until yours is in.</p>
          </Collapse>
        </div>
      </Demo>
      <Demo name="Thinking states">
        <span className="text-sm">
          <ThinkingStates lines={['Reading transcripts…', 'Searching resumes…', 'Citing candidates…']} />
        </span>
      </Demo>
      <Demo name="Streaming text">
        <button type="button" onClick={() => setAnswer((a) => a + 1)} className="text-left">
          <StreamingText
            key={answer}
            text="Maya Chen led the design-system migration at Figment, per her final-round transcript."
            className="text-sm"
          />
        </button>
      </Demo>
    </div>
  );
}

export function BotLab() {
  const states: BotState[] = ['idle', 'working', 'sleeping'];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
      {states.map((s) => (
        <Card key={s} className="flex flex-col items-center gap-4 px-5 pb-5 pt-8">
          <Bot state={s} size={72} />
          <p className="text-sm">
            {s === 'idle' ? 'Idle — ready' : s === 'working' ? 'Working — request in flight' : 'Sleeping — AI not set up'}
          </p>
        </Card>
      ))}
    </div>
  );
}

export function ChartLab() {
  const [bump, setBump] = useState(0);
  const stages = [
    ['New applicant', 38],
    ['Phone screen', 24],
    ['On-site', 11],
    ['Offer', 4],
    ['Hired', 2],
  ] as const;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xs font-medium text-ink-2">Active pipeline by stage</h3>
          <Button size="xs" variant="tonal" onClick={() => setBump((b) => b + 1)}>
            Shuffle
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {stages.map(([name, n], i) => {
            const v = bump ? Math.max(1, Math.round(n * (0.5 + ((i * 37 + bump * 53) % 100) / 100))) : n;
            return (
              <div key={name} className="grid grid-cols-[120px_1fr_32px] items-center gap-3">
                <span className="truncate text-sm">{name}</span>
                <DitherBar value={v} max={40} />
                <span className="text-right text-xs text-ink-2 tabular-nums">{v}</span>
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="mb-4 text-xs font-medium text-ink-2">Time in stage</h3>
        <DitherColumns
          height={128}
          unit="d"
          data={[
            { label: 'New applicant', value: 3 },
            { label: 'Phone screen', value: 6 },
            { label: 'On-site', value: 11 },
            { label: 'Offer', value: 4 },
          ]}
        />
      </Card>
      <Card className="flex items-center gap-5 p-5">
        <DitherRing value={62} size={88} thickness={12}>
          <span className="text-md font-medium tabular-nums">62%</span>
        </DitherRing>
        <div>
          <p className="text-md font-medium">Offer acceptance</p>
          <p className="text-sm text-ink-2">5 of 8 offers accepted this quarter</p>
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-md font-medium">Onboarding</p>
          <p className="text-lg font-medium tabular-nums">80%</p>
        </div>
        <DitherBar value={80} max={100} height={9} className="mt-3" />
      </Card>
    </div>
  );
}
