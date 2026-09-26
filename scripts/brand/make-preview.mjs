#!/usr/bin/env node
/**
 * Contact sheet for the brand kit, rendered in Chrome at 1x so every
 * favicon shows at its real pixel size: public/brand/preview.png.
 *
 * It also checks that the mark is the app's orb: it runs renderStill from
 * src/components/ui/orb.tsx (the still orb every list and header draws) in
 * the browser for <Orb palette="ember" />, the homepage's orb, and compares
 * it, pixel for pixel, with public/brand/source-mark.png and
 * source-mark-large.png.
 *
 *   node scripts/brand/make-preview.mjs
 *
 * Needs Google Chrome installed (playwright-core drives the system Chrome).
 * Run scripts/brand/make-brand-assets.py first.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = join(ROOT, 'public', 'brand');
const FAV = join(BRAND, 'favicon');
const WIDTH = 1680; // the sheet's width in CSS px, screenshotted at 1x

const dataUrl = (path, type) =>
  `data:${type ?? (path.endsWith('.svg') ? 'image/svg+xml' : 'image/png')};base64,${readFileSync(path).toString('base64')}`;
const brand = (f) => dataUrl(join(BRAND, f));
const fav = (f) => dataUrl(join(FAV, f));
const font = (f) => dataUrl(join(ROOT, 'public', 'fonts', f), 'font/woff2');

// ── The app's own still-orb renderer, lifted out of orb.tsx ────────────────
function appRenderer() {
  const src = readFileSync(join(ROOT, 'src', 'components', 'ui', 'orb.tsx'), 'utf8');
  const bayer = src.slice(src.indexOf('const BAYER8 = '), src.indexOf('})();', src.indexOf('const BAYER8 = ')) + 5);
  const start = src.indexOf('function renderStill(');
  const end = src.indexOf('\n}\n', start) + 3;
  if (start < 0 || !bayer.startsWith('const BAYER8')) throw new Error('renderStill not found in orb.tsx');
  const palettes = readFileSync(join(ROOT, 'src', 'components', 'ui', 'orb-palettes.ts'), 'utf8').replace(/^export /gm, '');
  const js = ts.transpileModule(`${palettes}\n${bayer}\n${src.slice(start, end)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return `${js}\nwindow.__orb = { renderStill, orbFor, ORB_PALETTES };`;
}

async function checkMark(page) {
  return page.evaluate(
    async ({ marks }) => {
      const { renderStill, orbFor, ORB_PALETTES } = window.__orb;
      // <Orb palette="ember" />: the palette is forced, the angle comes from the
      // (empty) seed, and StaticDitherOrb snaps it to one of eight directions.
      const palette = 'ember';
      const { angle } = orbFor('');
      const snapped = (Math.round(angle / 45) % 8) * 45;
      const { ink, paper } = ORB_PALETTES[palette];
      const results = [];
      for (const { size, src } of marks) {
        const app = renderStill(ink, paper, size, snapped, false, 1, 1).getContext('2d').getImageData(0, 0, size, size).data;
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const ours = ctx.getImageData(0, 0, size, size).data;
        let diff = 0;
        for (let i = 0; i < app.length; i += 4) {
          const a = app[i + 3] > 127 ? `${app[i]},${app[i + 1]},${app[i + 2]}` : '-';
          const b = ours[i + 3] > 127 ? `${ours[i]},${ours[i + 1]},${ours[i + 2]}` : '-';
          if (a !== b) diff++;
        }
        results.push({ size, palette, angle, snapped, diff });
      }
      return results;
    },
    {
      marks: [
        { size: 32, src: brand('source-mark.png') },
        { size: 64, src: brand('source-mark-large.png') },
      ],
    },
  );
}

// ── Contact sheet ──────────────────────────────────────────────────────────
const SMALL = [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['favicon-48.png', 48],
  ['favicon-96.png', 96],
];
const LARGE = [
  // [file, size, px per orb cell] — the big icons are the 32-cell orb at whole-pixel multiples
  ['apple-touch-icon.png', 180, 4],
  ['icon-192.png', 192, 6],
  ['icon-512.png', 512, 16],
  ['icon-512-maskable.png', 512, 10],
];

const px = (f, size, extra = '') =>
  `<img src="${fav(f)}" width="${size}" height="${size}" style="image-rendering:pixelated;${extra}" alt="">`;

function tab(dark, scale) {
  // A Chrome-like tab strip. scale 2 draws the whole strip at twice the size
  // with the 32px icon, which is what a retina tab puts on screen.
  const s = (v) => v * scale;
  const bar = dark ? '#202124' : '#dee1e6';
  const active = dark ? '#35363a' : '#ffffff';
  const text = dark ? '#e8eaed' : '#3c4043';
  const icon = scale === 1 ? 'favicon-16.png' : 'favicon-32.png';
  const one = (title, on, img) => `
    <div style="display:flex;align-items:center;gap:${s(8)}px;height:${s(34)}px;padding:0 ${s(12)}px;width:${s(210)}px;
      border-radius:${s(8)}px ${s(8)}px 0 0;background:${on ? active : 'transparent'};color:${text};
      font:${s(12)}px/1 -apple-system, 'Segoe UI', sans-serif;white-space:nowrap;overflow:hidden">
      ${img}<span>${title}</span></div>`;
  return `<div style="display:flex;align-items:flex-end;gap:${s(2)}px;background:${bar};padding:${s(8)}px ${s(8)}px 0;border-radius:${s(10)}px ${s(10)}px 0 0">
      ${one('Pipeline · Source', true, px(icon, s(16), `width:${s(16)}px;height:${s(16)}px;flex:none`))}
      ${one('Inbox (3)', false, `<span style="width:${s(16)}px;height:${s(16)}px;border-radius:50%;background:${dark ? '#5f6368' : '#9aa0a6'};flex:none"></span>`)}
    </div>
    <div style="height:${s(28)}px;background:${active};display:flex;align-items:center;padding:0 ${s(12)}px">
      <div style="flex:1;height:${s(18)}px;border-radius:${s(9)}px;background:${dark ? '#202124' : '#f1f3f4'};color:${dark ? '#9aa0a6' : '#5f6368'};font:${s(11)}px/${s(18)}px -apple-system, sans-serif;padding:0 ${s(10)}px">source-ats.vercel.app/pipeline</div>
    </div>`;
}

function html() {
  const panel = (dark, inner, pad = 32) =>
    `<div class="panel" style="background:${dark ? '#0F0F0E' : '#FFFFFF'};padding:${pad}px">${inner}</div>`;
  const label = (t) => `<div class="label">${t}</div>`;
  const file = (t) => `<div class="file">${t}</div>`;
  const item = (name, img) => `<div>${file(name)}${img}</div>`;

  const lockups = (theme) => `
    <div class="stack">
      ${item(`source-lockup-${theme}.svg · 32px tall (1×)`, `<img src="${brand(`source-lockup-${theme}.svg`)}" height="32">`)}
      ${item('same, 64px tall', `<img src="${brand(`source-lockup-${theme}.svg`)}" height="64">`)}
      ${item(`source-lockup-large-${theme}.svg · 128px tall`, `<img src="${brand(`source-lockup-large-${theme}.svg`)}" height="128">`)}
    </div>`;

  const wordAndMark = (theme) => `
    <div class="stack">
      ${item(`source-wordmark-${theme}.svg`, `<img src="${brand(`source-wordmark-${theme}.svg`)}" height="30">`)}
      <div class="row">
        ${item('source-mark.svg · 32', `<img src="${brand('source-mark.svg')}" width="32">`)}
        ${item('same, 64', `<img src="${brand('source-mark.svg')}" width="64">`)}
        ${item('source-mark-large.svg · 128', `<img src="${brand('source-mark-large.svg')}" width="128">`)}
      </div>
    </div>`;

  const small = `
    <div class="row" style="gap:32px">
      ${SMALL.map(([f, size]) => item(f, px(f, size))).join('')}
      ${item('icon.svg at 16', `<img src="${fav('icon.svg')}" width="16" height="16">`)}
      ${item('icon.svg at 32', `<img src="${fav('icon.svg')}" width="32" height="32">`)}
    </div>`;

  // 8×, nearest neighbour. The big icons show an 8× window on the S
  // shoulder: the smooth letter, the cleared gap and the cells meet there.
  const zoom = (f, size) => item(`${f} · 8×`, px(f, size * 8));
  const zoomCrop = (f, size, cell) => {
    const off = (size - 32 * cell) / 2;
    const w = 40;
    // Up to 6px cells the window takes in dots, the gap and the S; at 10px
    // and up the gap alone is wider than the window, so it sits on the S.
    const cx = Math.round(cell < 10 ? off + 6.2 * cell - 16 : off + 5.8 * cell - 6);
    const cy = Math.round(cell < 10 ? off + 10 * cell - 8 : off + 11.8 * cell - 10);
    return item(
      `${f} · 8× crop`,
      `<div style="width:${w * 8}px;height:${w * 8}px;overflow:hidden;position:relative">
        ${px(f, size * 8, `position:absolute;left:${-cx * 8}px;top:${-cy * 8}px;max-width:none`)}</div>`,
    );
  };

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: Geist; src: url(${font('Geist-Regular.woff2')}); font-weight: 400; }
    @font-face { font-family: Geist; src: url(${font('Geist-Medium.woff2')}); font-weight: 500; }
    @font-face { font-family: Mono; src: url(${font('FragmentMono-Regular.woff2')}); }
    * { box-sizing: border-box; margin: 0; }
    body { background: #F5F4F2; color: #0A0A0A; font: 400 14px/20px Geist, sans-serif; padding: 48px; width: ${WIDTH}px; }
    h1 { font-size: 20px; line-height: 28px; font-weight: 500; letter-spacing: -0.015em; }
    .sub { color: #6B6A67; font-size: 13px; margin-top: 4px; max-width: 900px; }
    .label { font-size: 12px; line-height: 16px; font-weight: 500; color: #6B6A67; margin: 40px 0 12px; }
    .file { font: 11px/16px Mono, monospace; color: #9B9A96; margin-bottom: 8px; white-space: nowrap; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .panel { border-radius: 12px; }
    .stack { display: flex; flex-direction: column; gap: 28px; }
    .row { display: flex; gap: 40px; flex-wrap: wrap; align-items: flex-start; }
    img { display: block; }
  </style></head><body>
    <h1>Source brand kit</h1>
    <div class="sub">The mark is the app's ember orb, the one on the homepage (lit from the upper left), cell for cell what the app draws.
      The favicons write SRC in Fragment Mono across it, with the dither cleared around each letter.
      Everything on this sheet is at 1× (one image pixel per screen pixel) unless it says 8×.</div>

    ${label('Lockup')}
    <div class="grid2">${panel(false, lockups('light'))}${panel(true, lockups('dark'))}</div>

    ${label('Wordmark and mark')}
    <div class="grid2">${panel(false, wordAndMark('light'))}${panel(true, wordAndMark('dark'))}</div>

    ${label('Favicons at 1×')}
    <div class="grid2">${panel(false, small, 24)}${panel(true, small, 24)}</div>
    <div style="margin-top:12px">${panel(false, `<div class="row" style="gap:24px">${LARGE.map(([f, size]) => item(f, px(f, size))).join('')}</div>`, 24)}</div>

    ${label('Favicons at 8×, nearest neighbour')}
    ${panel(false, `<div class="stack">
      <div class="row" style="gap:32px">${SMALL.slice(0, 3).map(([f, size]) => zoom(f, size)).join('')}${zoomCrop('favicon-96.png', 96, 3)}</div>
      <div class="row" style="gap:32px">${LARGE.map(([f, size, cell]) => zoomCrop(f, size, cell)).join('')}</div>
    </div>`, 24)}

    ${label('In a browser tab · 1× with the 16px icon, and retina with the 32px icon (drawn at twice the size)')}
    <div class="grid2">
      <div class="stack" style="gap:12px">${tab(false, 1)}${tab(true, 1)}</div>
      <div class="stack" style="gap:12px">${tab(false, 2)}${tab(true, 2)}</div>
    </div>

    ${label('On a home screen · apple-touch-icon under the iOS mask (180px, an iPhone at 3×) and the maskable icon under a circle mask (192px, Android)')}
    <div class="row" style="gap:12px">
      <div style="padding:32px;background:linear-gradient(135deg,#3b4a6b,#1d2233);border-radius:12px">
        ${px('apple-touch-icon.png', 180, 'border-radius:40px')}
      </div>
      <div style="padding:26px;background:#e8eaed;border-radius:12px">
        ${px('icon-512-maskable.png', 192, 'border-radius:50%;image-rendering:auto')}
      </div>
      <div style="padding:26px;background:#202124;border-radius:12px">
        ${px('icon-512-maskable.png', 192, 'border-radius:50%;image-rendering:auto')}
      </div>
    </div>
  </body></html>`;
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: WIDTH, height: 1000 } });
  await page.setContent('<!doctype html><title>check</title>');
  await page.addScriptTag({ content: appRenderer() });
  const checks = await checkMark(page);
  for (const c of checks) {
    console.log(
      `mark ${c.size}px vs the app's renderStill (${c.palette}, angle ${c.angle}→${c.snapped}): ${c.diff === 0 ? 'identical' : `${c.diff} pixels differ`}`,
    );
  }
  if (checks.some((c) => c.diff !== 0)) process.exitCode = 1;

  const sheet = join(tmpdir(), `source-brand-preview-${process.pid}.html`);
  writeFileSync(sheet, html());
  await page.goto(`file://${sheet}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(BRAND, 'preview.png'), fullPage: true });
  unlinkSync(sheet);
  console.log('wrote public/brand/preview.png');
} finally {
  await browser.close();
}
