import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { useDialKitController } from 'dialkit';
import { Orb, type OrbDither } from '@/components/ui/orb';
import { ORB_PALETTES, type OrbPalette } from '@/components/ui/orb-palettes';
import { DitherBar, DitherColumns, DitherRing, type DitherOptions } from '@/components/ui/dither';
import { copyText, Dials, prompt, useCopied, useLatest } from './dials';

/**
 * Every dither in the system on dials: the orb's (cell size, tone steps,
 * light) and the charts' (pitch, gap, Bayer matrix, dot shape, density
 * ramp, entrance). Only dials you move are passed on, so an untouched dial
 * keeps each chart's own default.
 */

const PALETTES = Object.keys(ORB_PALETTES) as OrbPalette[];

const ORB = { cellPx: 1.5, levels: 3, contrast: 1.1, gain: 1, light: 0.9, rim: 0.35, plasma: 0.9, speed: 0.5 };
/** Each chart's own defaults, as dither.tsx sets them. */
type ChartLook = { pitch: number; gap: number; matrix: string; shape: string; track: boolean; floor: number; peak: number };
const LOOK = { gap: 1, matrix: '8', shape: 'square', track: true, floor: 0.55, peak: 1 };
const COLUMNS: ChartLook = { pitch: 3, ...LOOK };
const BAR: ChartLook = { ...LOOK, pitch: 2, gap: 0.5, floor: 0.5 };
const RING: ChartLook = { ...LOOK, pitch: 3, floor: 0.5 };
const ENTER_MS = 550;

/** One chart's dials. Each chart gets its own set, so tuning one leaves the others alone. */
const chartDials = (d: ChartLook) => ({
  pitch: [d.pitch, 1, 8, 1] as [number, number, number, number],
  gap: [d.gap, 0, 4, 0.5] as [number, number, number, number],
  matrix: { type: 'select' as const, options: ['2', '4', '8'], default: d.matrix },
  shape: { type: 'select' as const, options: ['square', 'round'], default: d.shape },
  track: d.track,
  floor: [d.floor, 0, 1, 0.05] as [number, number, number, number],
  peak: [d.peak, 0, 1, 0.05] as [number, number, number, number],
});

const DAYS = [
  { label: 'Screen', value: 4 },
  { label: 'On-site', value: 9 },
  { label: 'Offer', value: 3 },
  { label: 'Hired', value: 6 },
];

function DitherPlayground() {
  const [replay, setReplay] = useState(0);
  const { flash, note } = useCopied();

  const dial = useDialKitController(
    'Dither',
    {
      Orb: {
        palette: { type: 'select', options: PALETTES, default: 'ember' },
        size: [200, 64, 360, 4],
        animate: true,
        cellPx: [ORB.cellPx, 1, 8, 0.25],
        levels: [ORB.levels, 2, 8, 1],
        contrast: [ORB.contrast, 0.2, 4, 0.05],
        gain: [ORB.gain, 0.2, 3, 0.05],
        light: [ORB.light, 0, 3, 0.05],
        rim: [ORB.rim, 0, 3, 0.05],
        plasma: [ORB.plasma, 0, 3, 0.05],
        speed: [ORB.speed, 0, 5, 0.05],
      },
      Bar: chartDials(BAR),
      Ring: { sameAsBar: false, ...chartDials(RING), _collapsed: true },
      Columns: { ...chartDials(COLUMNS), _collapsed: true },
      Entrance: { enterMs: [ENTER_MS, 0, 2000, 50], replay: { type: 'action', label: 'Replay entrance' } },
      reset: { type: 'action', label: 'Reset to defaults' },
      copy: { type: 'action', label: 'Copy for Claude' },
    },
    {
      id: 'playground-dither',
      persist: true,
      onAction: (path) => {
        if (path === 'reset') return dialRef.current.resetValues();
        if (path.endsWith('replay')) return setReplay((n) => n + 1);
        if (path === 'copy') {
          copyText(ditherPrompt(latest.current));
          flash();
        }
      },
    },
  );
  const dialRef = useLatest(dial);
  const values = dial.values;
  const latest = useLatest(values);

  const orb = orbDither(values.Orb);
  const charts = chartOptions(values);

  return (
    <div className="min-h-screen bg-canvas p-8 text-ink lg:pr-[340px]">
      <Dials />
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <p className="text-sm text-ink-2">Playground</p>
          <h1 className="mt-1 text-4xl text-ink">Tune the dither</h1>
          <p className="mt-2 max-w-lg text-md text-ink-2">
            The orb&apos;s dither and the charts&apos;. Move a dial, then Copy for Claude.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center justify-center gap-5 rounded-card bg-surface p-6">
            <Orb
              palette={values.Orb.palette as OrbPalette}
              size={values.Orb.size}
              animate={values.Orb.animate}
              dither={orb}
            />
            {/* the still orb and the soft (avatar) orb: only cell size reaches these */}
            <div className="flex items-center gap-3">
              <Orb palette={values.Orb.palette as OrbPalette} size={48} dither={{ cellPx: orb.cellPx }} />
              <Orb palette={values.Orb.palette as OrbPalette} size={32} soft dither={{ cellPx: orb.cellPx }} />
              <p className="text-xs text-ink-2">Still orb · avatar orb</p>
            </div>
          </div>

          <div key={replay} className="flex flex-col gap-6 rounded-card bg-surface p-6">
            <DitherColumns data={DAYS} unit="d" dither={charts.columns} />
            <DitherBar value={64} max={128} dither={charts.bar} />
            <div className="flex items-center gap-4">
              <DitherRing value={72} size={72} dither={charts.ring}>
                <span className="text-sm tabular-nums">72%</span>
              </DitherRing>
              <p className="text-sm text-ink-2">
                {values.Ring.sameAsBar ? 'The ring follows the bar’s dials.' : 'The ring has its own dials.'}
              </p>
            </div>
          </div>
        </div>
        {note}
      </div>
    </div>
  );
}

type OrbValues = typeof ORB & { palette: string; size: number; animate: boolean };
type ChartValues = ChartLook;
type Values = {
  Orb: OrbValues;
  Bar: ChartValues;
  Ring: ChartValues & { sameAsBar: boolean };
  Columns: ChartValues;
  Entrance: { enterMs: number };
};

/** Only the orb dials that moved. */
function orbDither(v: OrbValues): OrbDither {
  const out: OrbDither = {};
  for (const k of Object.keys(ORB) as (keyof typeof ORB)[]) if (v[k] !== ORB[k]) out[k] = v[k];
  return out;
}

/** Only one chart's dials that moved from its own defaults. */
function chartDither(v: ChartValues, d: ChartLook): DitherOptions {
  const out: DitherOptions = {};
  if (v.pitch !== d.pitch) out.pitch = v.pitch;
  if (v.gap !== d.gap) out.gap = v.gap;
  if (v.matrix !== d.matrix) out.matrix = Number(v.matrix) as 2 | 4 | 8;
  if (v.shape !== d.shape) out.shape = v.shape as 'square' | 'round';
  if (v.track !== d.track) out.track = v.track;
  if (v.floor !== d.floor) out.floor = v.floor;
  if (v.peak !== d.peak) out.peak = v.peak;
  return out;
}

/** The dither each chart gets: its own dials (the ring can follow the bar's), plus the shared entrance. */
function chartOptions(v: Values) {
  const enter: DitherOptions = v.Entrance.enterMs !== ENTER_MS ? { enterMs: v.Entrance.enterMs } : {};
  const bar = { ...chartDither(v.Bar, BAR), ...enter };
  return {
    columns: { ...chartDither(v.Columns, COLUMNS), ...enter },
    bar,
    ring: v.Ring.sameAsBar ? { ...chartDither(v.Bar, RING), ...enter } : { ...chartDither(v.Ring, RING), ...enter },
  };
}

function ditherPrompt(v: Values) {
  const orb = orbDither(v.Orb);
  const parts: string[] = [];

  if (Object.keys(orb).length) {
    const lines = Object.entries(orb).map(([k, val]) => `- ${k}: ${ORB[k as keyof typeof ORB]} → ${val}`);
    parts.push(`Orb (src/components/ui/orb.tsx, shader defaults in src/components/ui/shdr-14.tsx):
${lines.join('\n')}
cellPx sets the dither cell size: change the cells formula in Orb and the cellPx default in renderStill. The other keys are SHDR-14 params: change their defaults in shdr14Orb.params.`);
  }

  const ringValues = v.Ring.sameAsBar ? v.Bar : v.Ring;
  const perChart: [string, ChartValues, ChartLook][] = [
    ['DitherBar', v.Bar, BAR],
    ['DitherRing', ringValues, RING],
    ['DitherColumns', v.Columns, COLUMNS],
  ];
  const chartLines: string[] = [];
  for (const [name, values, d] of perChart) {
    const moved = chartDither(values, d);
    const keys = Object.keys(moved) as (keyof DitherOptions)[];
    if (!keys.length) continue;
    chartLines.push(`- ${name}: ${keys.map((k) => `${k} ${JSON.stringify(d[k as keyof ChartLook])} → ${JSON.stringify(moved[k])}`).join(', ')}`);
  }
  if (v.Entrance.enterMs !== ENTER_MS) chartLines.push(`- all charts: enterMs ${ENTER_MS} → ${v.Entrance.enterMs} (ENTER_MS)`);
  if (chartLines.length) {
    parts.push(`Dither charts (src/components/ui/dither.tsx). Only the charts listed changed; leave the others as they are:
${chartLines.join('\n')}
Each chart passes its own options to useDither ({ ...BASE, pitch, floor, peak, ...dither }): put a chart's changed values in that call, and only move a value into BASE if all three charts share it.`);
  }

  if (!parts.length) return 'No dither changes yet. Move a dial first.';
  return prompt(
    'Make these the new default dither look in Orqestra (tuned in the Storybook dither playground):',
    `${parts.join('\n\n')}

Update the dither notes in docs/09-design-system.md (orb and charts sections) to match, and check the orb still renders its live shader only at 64px and up.`,
  );
}

const meta = {
  title: 'Playground/Dither',
  component: DitherPlayground,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DitherPlayground>;

export default meta;
export const Dither: StoryObj<typeof meta> = {};
