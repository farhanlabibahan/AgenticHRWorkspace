#!/usr/bin/env python3
"""
Source brand kit generator: the orb mark, the "Source" wordmark, the lockup,
and every favicon, all built from code so they can be regenerated.

    python3 -m venv .venv-brand
    .venv-brand/bin/pip install -r scripts/brand/requirements.txt
    .venv-brand/bin/python scripts/brand/make-brand-assets.py
    node scripts/brand/make-preview.mjs      # contact sheet -> public/brand/preview.png

What it builds
- The mark is the app's own orb, as the homepage draws it with
  <Orb palette="ember" />: a port of the still renderer in
  src/components/ui/orb.tsx (renderStill), with the ember palette and the
  light angle orbFor() gives seed "source" (src/components/ui/orb-palettes.ts).
  Same hash, same Bayer matrix, same lighting, so the logo is the orb the
  app draws.
- The wordmark is "Source" in Geist Medium (public/fonts), shaped with
  HarfBuzz so the font's own kerning applies, then converted to outlines.
  No SVG here needs the font installed.
- The favicons write "SRC" in Fragment Mono (the app's short wordmark)
  across the orb, with the dither cleared in a margin around each letter.
- Every pixel image of the orb is rendered natively: the dither cell is a
  whole number of pixels at every size, never a big image scaled down (that
  averages the dither into mush). Text in PNGs is rasterized by FreeType.

Writes public/brand/** and the Next.js icon files in src/app/
(favicon.ico, apple-icon.png).
"""

from __future__ import annotations

import io
import math
import os
import struct
from dataclasses import dataclass

import freetype
import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.freetypePen import FreeTypePen
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BRAND = os.path.join(ROOT, 'public', 'brand')
APP = os.path.join(ROOT, 'src', 'app')
FONT = os.path.join(ROOT, 'public', 'fonts', 'Geist-Medium.woff2')

# ── Tokens (docs/09 §2) ─────────────────────────────────────────────────────
CANVAS_LIGHT = '#F5F4F2'  # light canvas: the touch and maskable icons' background
INK_LIGHT = '#0A0A0A'  # text on light (canvas #F5F4F2)
INK_DARK = '#F5F4F2'  # text on dark (canvas #0F0F0E)

# ── Lockup geometry, in units of one orb cell (1 unit = 1px at 1x) ──────────
WORD = 'Source'
SEED = 'source'
ORB_GRID = 32  # the 32px orb the app draws beside "Source" (onboarding header)
ORB_GRID_LARGE = 64  # the app's still orb at 96px (empty states): big uses
# Orb diameter : cap height. The onboarding header is 32px : 18px text (2.5),
# which is the mark shouting; at 2 and under the word takes over.
CAP_RATIO = 2.2
# Space from the orb's edge to the S's ink, as a fraction of the orb diameter.
GAP = 0.28
# Where the orb's centre sits, as a fraction of the cap height above the
# baseline. 0.5 centres it on the capitals; "Source" is one capital and five
# lowercase letters, so its visual centre sits a little lower.
VALIGN = 0.46
# Tracking in em. Display type in the system tightens (docs/09 §3).
TRACKING = -0.02


# ── The orb: a port of renderStill (src/components/ui/orb.tsx) ──────────────
ORB_PALETTES = {  # src/components/ui/orb-palettes.ts
    'ember': ('#3a1a12', '#f2a58f'),
    'lavender': ('#1f1850', '#d9d3fb'),
    'iris': ('#141848', '#a9c8f4'),
    'prism': ('#3a2410', '#f6d68e'),
    'glacier': ('#101426', '#cfe6ff'),
    'sage': ('#122418', '#c9ddc2'),
}


def fnv1a(seed: str) -> int:
    """orb-palettes.ts hash(): FNV-1a over UTF-16 code units, as uint32."""
    h = 2166136261
    units = seed.encode('utf-16-le')  # charCodeAt() reads UTF-16 code units
    for k in range(0, len(units), 2):
        c = units[k] | (units[k + 1] << 8)
        h = ((h ^ c) * 16777619) & 0xFFFFFFFF
    return h


def orb_for(seed: str) -> tuple[str, int]:
    """orbFor(): palette and light angle for a seed."""
    h = fnv1a(seed or 'source')
    keys = list(ORB_PALETTES)
    return keys[h % len(keys)], (h >> 8) % 360


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def bayer8() -> list[float]:
    """The 8×8 ordered Bayer thresholds, built exactly as orb.tsx builds them."""
    m = []
    for y in range(8):
        for x in range(8):
            v, xx, yy = 0, x, y
            for bit in range(3):
                v |= (((xx ^ yy) & 1) << (2 * (2 - bit) + 1)) | ((yy & 1) << (2 * (2 - bit)))
                xx >>= 1
                yy >>= 1
            m.append((v + 0.5) / 64)
    return m


BAYER8 = bayer8()

# The brand orb is the homepage's <Orb palette="ember" />: the palette is
# forced, and the light angle is the seed's. That orb passes no seed, and
# orbFor('') falls back to 'source', so it is the same angle.
PALETTE = 'ember'
_, ANGLE = orb_for(SEED)
# StaticDitherOrb snaps the light to one of eight directions.
SNAPPED = (js_round(ANGLE / 45) % 8) * 45
ORB_INK, ORB_PAPER = ORB_PALETTES[PALETTE]

# A cell is None (outside the disc), False (ink) or True (paper).
Grid = list[list]


def orb_grid(n: int, angle: float = SNAPPED) -> Grid:
    """renderStill for an n×n cell grid (size n, one cell per px, soft=false)."""
    a = angle * math.pi / 180
    L = [math.cos(a) * 0.35 - 0.45, -0.55 + math.sin(a) * 0.2, 0.7]
    ln = math.hypot(L[0], L[1], L[2])
    rows = []
    for j in range(n):
        row = []
        for i in range(n):
            x = ((i + 0.5) / n) * 2 - 1
            y = ((j + 0.5) / n) * 2 - 1
            r2 = x * x + y * y
            if r2 > 1:
                row.append(None)
                continue
            z = math.sqrt(1 - r2)
            lambert = max(0.0, (x * L[0] + y * L[1] + z * L[2]) / ln)
            plasma = 0.5 + 0.5 * math.sin(x * 3.1 + a) * math.sin(y * 2.7 - a * 0.7 + z * 2.0)
            rim = math.pow(1 - z, 3)
            lum = 0.15 + 0.7 * lambert + 0.18 * (plasma - 0.5) + 0.35 * rim
            row.append(lum > BAYER8[(j & 7) * 8 + (i & 7)])
        rows.append(row)
    return rows


# ── SVG ─────────────────────────────────────────────────────────────────────
def num(v: float, places: int = 2) -> str:
    s = f'{v:.{places}f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def runs(row: list, want) -> list[tuple[int, int]]:
    """[start, end) runs of cells equal to `want` (or of any in-disc cell if want is ...)."""
    out, start = [], None
    for i, v in enumerate(row + [None]):
        hit = (v is not None) if want is ... else (v is want)
        if hit and start is None:
            start = i
        elif not hit and start is not None:
            out.append((start, i))
            start = None
    return out


def merged_rects(grid: Grid, want) -> list[tuple[int, int, int, int]]:
    """Horizontal runs, stacked into taller rects where consecutive rows repeat a run."""
    open_rects: dict[tuple[int, int], list[int]] = {}
    done = []
    for j, row in enumerate(grid):
        row_runs = set(runs(row, want))
        for key in list(open_rects):
            if key not in row_runs:
                x0, x1 = key
                y0, h = open_rects.pop(key)
                done.append((x0, y0, x1 - x0, h))
        for key in row_runs:
            if key in open_rects:
                open_rects[key][1] += 1
            else:
                open_rects[key] = [j, 1]
    for (x0, x1), (y0, h) in open_rects.items():
        done.append((x0, y0, x1 - x0, h))
    return sorted(done, key=lambda r: (r[1], r[0]))


def orb_svg(grid: Grid, x: float = 0, y: float = 0, cell: float = 1, indent: str = '  ') -> str:
    """The orb as rects on its cell grid: a paper disc, then ink on top.

    Painting paper under the ink (rather than tiling ink and paper side by
    side) means no background can show through a seam between two cells when
    the SVG is scaled to a size that doesn't land on whole pixels.
    """

    def rect(r):
        rx, ry, rw, rh = r
        return (
            f'<rect x="{num(x + rx * cell)}" y="{num(y + ry * cell)}" '
            f'width="{num(rw * cell)}" height="{num(rh * cell)}"/>'
        )

    paper = ''.join(rect(r) for r in merged_rects(grid, ...))
    ink = ''.join(rect(r) for r in merged_rects(grid, False))
    return (
        f'{indent}<g shape-rendering="crispEdges">\n'
        f'{indent}  <g fill="{ORB_PAPER}">{paper}</g>\n'
        f'{indent}  <g fill="{ORB_INK}">{ink}</g>\n'
        f'{indent}</g>\n'
    )


def svg_doc(w: float, h: float, body: str, title: str = 'Source', extra_head: str = '') -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{num(w)}" height="{num(h)}" '
        f'viewBox="0 0 {num(w)} {num(h)}" role="img" aria-label="{title}">\n'
        f'  <title>{title}</title>\n{extra_head}{body}</svg>\n'
    )


# ── The wordmark ────────────────────────────────────────────────────────────
@dataclass
class Placed:
    glyph: str
    x: float  # pen position in font units (includes kerning and tracking)


class Wordmark:
    """"Source" shaped by HarfBuzz (GPOS kerning), outlined from Geist Medium."""

    def __init__(self, text: str = WORD, tracking_em: float = TRACKING):
        font = TTFont(FONT)
        font.flavor = None  # woff2 -> plain sfnt for HarfBuzz
        buf = io.BytesIO()
        font.save(buf)
        self.font = TTFont(io.BytesIO(buf.getvalue()))
        self.glyphs = self.font.getGlyphSet()
        self.upm = self.font['head'].unitsPerEm
        self.cap = self.font['OS/2'].sCapHeight
        hb_font = hb.Font(hb.Face(buf.getvalue()))
        b = hb.Buffer()
        b.add_str(text)
        b.guess_segment_properties()
        hb.shape(hb_font, b, {'kern': True, 'liga': True})
        order = self.font.getGlyphOrder()
        track = tracking_em * self.upm
        self.placed: list[Placed] = []
        pen_x = 0.0
        infos = list(zip(b.glyph_infos, b.glyph_positions))
        for k, (info, pos) in enumerate(infos):
            self.placed.append(Placed(order[info.codepoint], pen_x + pos.x_offset))
            pen_x += pos.x_advance + (track if k < len(infos) - 1 else 0)
        self.kerning = [
            (order[i.codepoint], p.x_advance - self.font['hmtx'][order[i.codepoint]][0])
            for i, p in infos
        ]
        # Ink bounds in font units (y up).
        xs, ys = [], []
        for p in self.placed:
            bp = BoundsPen(self.glyphs)
            self.glyphs[p.glyph].draw(TransformPen(bp, (1, 0, 0, 1, p.x, 0)))
            if bp.bounds:
                xs += [bp.bounds[0], bp.bounds[2]]
                ys += [bp.bounds[1], bp.bounds[3]]
        self.ink = (min(xs), min(ys), max(xs), max(ys))

    def draw(self, pen, scale: float, ox: float, baseline: float):
        """Draw y-down at `scale` px per font unit, pen origin (ox, baseline)."""
        for p in self.placed:
            self.glyphs[p.glyph].draw(
                TransformPen(pen, (scale, 0, 0, -scale, ox + p.x * scale, baseline))
            )

    def svg_path(self, scale: float, ox: float, baseline: float, fill: str, indent: str = '  ') -> str:
        pen = SVGPathPen(self.glyphs, ntos=lambda v: num(v, 2))
        self.draw(pen, scale, ox, baseline)
        return f'{indent}<path fill="{fill}" d="{pen.getCommands()}"/>\n'

    def coverage(self, w: int, h: int, scale: float, ox: float, baseline: float) -> Image.Image:
        """Anti-aliased coverage mask (FreeType), in a y-down pixel box of w×h."""
        pen = FreeTypePen(None)
        # FreeType's outline space is y-up with the origin at the bitmap's
        # bottom-left; y_down = h - y_up.
        for p in self.placed:
            self.glyphs[p.glyph].draw(
                TransformPen(pen, (scale, 0, 0, scale, ox + p.x * scale, h - baseline))
            )
        buf, size = pen.buffer(width=w, height=h)
        return Image.frombytes('L', size, buf)


# ── Raster helpers ──────────────────────────────────────────────────────────
def rgb(hex_: str) -> tuple[int, int, int]:
    hex_ = hex_.lstrip('#')
    return tuple(int(hex_[i : i + 2], 16) for i in (0, 2, 4))


def paint_orb(im: Image.Image, grid: Grid, x0: int, y0: int, cell: int):
    """Stamp the orb's cells onto an RGBA image, each cell `cell` px square."""
    px = im.load()
    ink, paper = rgb(ORB_INK) + (255,), rgb(ORB_PAPER) + (255,)
    for j, row in enumerate(grid):
        for i, v in enumerate(row):
            if v is None:
                continue
            c = paper if v else ink
            for dy in range(cell):
                for dx in range(cell):
                    px[x0 + i * cell + dx, y0 + j * cell + dy] = c


def orb_png(grid: Grid, cell: int, size: int | None = None, bg: str | None = None) -> Image.Image:
    n = len(grid)
    d = n * cell
    size = size or d
    im = Image.new('RGBA', (size, size), rgb(bg) + (255,) if bg else (0, 0, 0, 0))
    off = (size - d) // 2
    assert (size - d) % 2 == 0, 'orb must centre on whole pixels'
    paint_orb(im, grid, off, off, cell)
    return im


def ink_layer(mask: Image.Image, color: str) -> Image.Image:
    layer = Image.new('RGBA', mask.size, rgb(color) + (0,))
    layer.putalpha(mask)
    return layer


def save_png(im: Image.Image, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, optimize=True)


def write(path: str, text: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


# ── Lockup and wordmark layout ──────────────────────────────────────────────
@dataclass
class Layout:
    w: int
    h: int
    scale: float  # px per font unit at 1x
    text_x: float  # pen origin of the word
    baseline: float
    orb_y: int = 0


def lockup_layout(word: Wordmark, d: int) -> Layout:
    """Mark + wordmark in one box: the orb at (0, orb_y), the word after the gap."""
    cap_px = d / CAP_RATIO
    scale = cap_px / word.cap
    x_min, y_min, x_max, y_max = word.ink
    # Orb centre at VALIGN × cap height above the baseline.
    baseline = d / 2 + VALIGN * cap_px
    text_x = d + GAP * d - x_min * scale  # gap measured to the S's ink, not its sidebearing
    top = min(0.0, baseline - y_max * scale)
    bottom = max(float(d), baseline - y_min * scale)
    assert top >= 0 and bottom <= d, 'the word should sit inside the orb height'
    w = math.ceil(text_x + x_max * scale)
    return Layout(w=w, h=d, scale=scale, text_x=text_x, baseline=baseline)


def wordmark_layout(word: Wordmark, cap_px: float) -> Layout:
    """The word alone, tight to its ink, centred in a whole-pixel box."""
    scale = cap_px / word.cap
    x_min, y_min, x_max, y_max = word.ink
    iw, ih = (x_max - x_min) * scale, (y_max - y_min) * scale
    w, h = math.ceil(iw), math.ceil(ih)
    text_x = (w - iw) / 2 - x_min * scale
    baseline = (h - ih) / 2 + y_max * scale
    return Layout(w=w, h=h, scale=scale, text_x=text_x, baseline=baseline)


def lockup_svg(word: Wordmark, grid: Grid, text_fill: str) -> tuple[str, Layout]:
    lay = lockup_layout(word, len(grid))
    body = orb_svg(grid, 0, lay.orb_y) + word.svg_path(lay.scale, lay.text_x, lay.baseline, text_fill)
    return svg_doc(lay.w, lay.h, body), lay


def lockup_png(word: Wordmark, grid: Grid, lay: Layout, text_fill: str, s: int) -> Image.Image:
    im = Image.new('RGBA', (lay.w * s, lay.h * s), (0, 0, 0, 0))
    paint_orb(im, grid, 0, lay.orb_y * s, s)
    mask = word.coverage(im.width, im.height, lay.scale * s, lay.text_x * s, lay.baseline * s)
    return Image.alpha_composite(im, ink_layer(mask, text_fill))


def wordmark_png(word: Wordmark, lay: Layout, fill: str, s: int) -> Image.Image:
    w, h = lay.w * s, lay.h * s
    mask = word.coverage(w, h, lay.scale * s, lay.text_x * s, lay.baseline * s)
    return ink_layer(mask, fill)


# ── Favicons: the orb with "SRC" knocked into it ────────────────────────────
# The app's short wordmark is "SRC" in Fragment Mono (the sidebar, the site
# nav). The favicon writes it across the orb and clears the dither in a
# margin around each letter, so the letters sit in a clean gap of the orb's
# light tone instead of fighting the dots. Letters are the orb's ink, so the
# icon stays two tones.
MONO_FONT = os.path.join(ROOT, 'public', 'fonts', 'FragmentMono-Regular.woff2')
FAVICON_TEXT = 'SRC'


@dataclass
class FavSpec:
    grid: int  # orb cells across
    cap: float  # cap height of SRC, in cells
    knockout: float  # dither is cleared within this radius of a letter cell (cells, centre to centre)
    tracking: float = 0.0  # em


# At 1px cells the letters are Fragment Mono's own hinted 1-bit rendering at
# that size, so they land on the pixel grid like the dither does. The C's
# aperture is what fails first: too little knockout leaves dots inside it and
# the C reads as a G. From 32px up the margin is a little over two cells.
# 16px, judged at 1x: 5px capitals turn to mush and a 1-cell margin reads
# "SRG". At a 5.5px size the hinter still draws 6px capitals but narrows each
# letter by a pixel, so SRC spans 14 columns instead of all 16, and a
# 1.5-cell knockout keeps a ring of dither on every side. It still reads as
# SRC on light and dark tab strips.
FAV_16 = FavSpec(grid=16, cap=5.5, knockout=1.5)
FAV_32 = FavSpec(grid=32, cap=8, knockout=2.3)
FAV_48 = FavSpec(grid=48, cap=11, knockout=3.2, tracking=0.05)


class MonoText:
    """SRC in Fragment Mono: layout on the cell grid, 1-bit hinted or outline rendering."""

    def __init__(self, text: str = FAVICON_TEXT):
        font = TTFont(MONO_FONT)
        font.flavor = None
        buf = io.BytesIO()
        font.save(buf)
        self.ttf = buf.getvalue()
        self.font = TTFont(io.BytesIO(self.ttf))
        self.glyphs = self.font.getGlyphSet()
        self.cap_units = self.font['OS/2'].sCapHeight
        cmap = self.font.getBestCmap()
        self.names = [cmap[ord(ch)] for ch in text]
        self.text = text

    def layout(self, spec: FavSpec) -> tuple[float, list[float], float]:
        """Scale (cells per unit), glyph origins and baseline, centred and on whole cells."""
        s = spec.cap / self.cap_units
        hmtx = self.font['hmtx']
        track = spec.tracking * self.font['head'].unitsPerEm
        pen_x, xs, bounds = 0.0, [], []
        for k, name in enumerate(self.names):
            bp = BoundsPen(self.glyphs)
            self.glyphs[name].draw(bp)
            bounds.append((pen_x + bp.bounds[0], pen_x + bp.bounds[2]))
            xs.append(pen_x)
            pen_x += hmtx[name][0] + track
        left, right = bounds[0][0] * s, bounds[-1][1] * s
        x0 = spec.grid / 2 - (left + right) / 2
        origins = [round(x0 + x * s) for x in xs]
        baseline = round(spec.grid / 2 + spec.cap / 2)
        return s, origins, baseline

    def mono_cells(self, spec: FavSpec) -> list[list[bool]]:
        """Letters as 1-bit pixels at one px per cell, hinted by the font's own instructions."""
        n = spec.grid
        _, origins, baseline = self.layout(spec)
        face = freetype.Face(io.BytesIO(self.ttf))
        ppem = spec.cap / self.cap_units * self.font['head'].unitsPerEm
        face.set_char_size(round(ppem * 64), 0, 72, 72)
        cells = [[False] * n for _ in range(n)]
        for name, ox in zip(self.names, origins):
            face.load_glyph(face.get_name_index(name.encode()), freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_MONO)
            g = face.glyph
            bm = g.bitmap
            data = bytes(bm.buffer)
            for y in range(bm.rows):
                for x in range(bm.width):
                    if data[y * bm.pitch + x // 8] & (0x80 >> (x % 8)):
                        cells[baseline - g.bitmap_top + y][ox + g.bitmap_left + x] = True
        return cells

    def outline_mask(self, spec: FavSpec, cell: int, size: int, off: int) -> Image.Image:
        """Anti-aliased letters for big icons, on the same cell layout."""
        s, origins, baseline = self.layout(spec)
        pen = FreeTypePen(None)
        for name, ox in zip(self.names, origins):
            self.glyphs[name].draw(
                TransformPen(pen, (s * cell, 0, 0, s * cell, off + ox * cell, size - off - baseline * cell))
            )
        buf, sz = pen.buffer(width=size, height=size)
        return Image.frombytes('L', sz, buf)

    def outline_cells(self, spec: FavSpec, threshold: float = 0.2) -> list[list[bool]]:
        """Which cells the outline letters cover (for the knockout on big icons)."""
        ss = 8
        mask = self.outline_mask(spec, ss, spec.grid * ss, 0)
        cells = []
        for j in range(spec.grid):
            row = []
            for i in range(spec.grid):
                box = mask.crop((i * ss, j * ss, (i + 1) * ss, (j + 1) * ss))
                row.append(sum(box.tobytes()) / (255 * ss * ss) > threshold)
            cells.append(row)
        return cells


def knocked_grid(spec: FavSpec, letters: list[list[bool]], draw_letters: bool) -> Grid:
    """The orb with every cell within `knockout` of a letter cleared to paper.

    With draw_letters the letter cells themselves are ink, making the whole
    icon one two-tone cell grid (1px cells); otherwise the letters are drawn
    on top afterwards (big icons, where they can be smooth).
    """
    n = spec.grid
    orb = orb_grid(n)
    r = spec.knockout
    reach = math.ceil(r)
    pts = [(i, j) for j in range(n) for i in range(n) if letters[j][i]]
    out = [row[:] for row in orb]
    for i, j in pts:
        assert orb[j][i] is not None, 'SRC must sit inside the orb'
        for dj in range(-reach, reach + 1):
            for di in range(-reach, reach + 1):
                y, x = j + dj, i + di
                if 0 <= x < n and 0 <= y < n and orb[y][x] is not None and math.hypot(di, dj) <= r:
                    out[y][x] = True
    if draw_letters:
        for i, j in pts:
            out[j][i] = False
    return out


def favicon_pixel(mono: MonoText, spec: FavSpec) -> tuple[Grid, Image.Image]:
    """A 1px-cell favicon: dither, knockout and letters all on the pixel grid."""
    grid = knocked_grid(spec, mono.mono_cells(spec), draw_letters=True)
    return grid, orb_png(grid, 1)


def favicon_smooth(mono: MonoText, spec: FavSpec, cell: int, size: int, bg: str | None = None) -> Image.Image:
    """A big favicon: the 32-cell orb at `cell` px per cell, letters as smooth outlines."""
    grid = knocked_grid(spec, mono.outline_cells(spec), draw_letters=False)
    im = orb_png(grid, cell, size, bg)
    off = (size - spec.grid * cell) // 2
    return Image.alpha_composite(im, ink_layer(mono.outline_mask(spec, cell, size, off), ORB_INK))


def favicon_svg(g32: Grid, g16: Grid) -> str:
    """The SVG favicon: the 32px favicon's cells, with the 16px one swapped in when drawn tiny.

    Drawn as an image at 16px (an <img>, CSS), the media query shows the
    16-cell version (each of its cells is 2 units), so neither size is a
    resampled copy of the other.

    It is not wired into the app; see main().
    """
    style = (
        '  <style>.g16{display:none}'
        '@media (max-width:24px){.g16{display:inline}.g32{display:none}}</style>\n'
    )
    body = (
        '  <g class="g32">\n' + orb_svg(g32, 0, 0, 1, '    ') + '  </g>\n'
        '  <g class="g16">\n' + orb_svg(g16, 0, 0, 2, '    ') + '  </g>\n'
    )
    return svg_doc(32, 32, body, title='Source', extra_head=style)


def write_ico(path: str, frames: list[Image.Image]):
    """ICO with PNG-compressed frames, each rendered natively (no resampling)."""
    blobs = []
    for im in frames:
        b = io.BytesIO()
        im.save(b, 'PNG', optimize=True)
        blobs.append(b.getvalue())
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b''
    for im, blob in zip(frames, blobs):
        w, h = im.size
        entries += struct.pack(
            '<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(blob), offset
        )
        offset += len(blob)
    with open(path, 'wb') as f:
        f.write(header + entries + b''.join(blobs))


# ── Build ───────────────────────────────────────────────────────────────────
def main():
    word = Wordmark()
    g32, g64 = orb_grid(ORB_GRID), orb_grid(ORB_GRID_LARGE)
    files: list[str] = []

    def out(rel: str) -> str:
        files.append(rel)
        return os.path.join(BRAND, rel)

    # Lockups: standard (32-grid orb, 1x = 32px tall) and large (64-grid).
    for name, grid in (('lockup', g32), ('lockup-large', g64)):
        for theme, fill in (('light', INK_LIGHT), ('dark', INK_DARK)):
            svg, lay = lockup_svg(word, grid, fill)
            write(out(f'source-{name}-{theme}.svg'), svg)
            for s in (1, 2, 4):
                suffix = '' if s == 1 else f'@{s}x'
                save_png(lockup_png(word, grid, lay, fill, s), out(f'source-{name}-{theme}{suffix}.png'))

    # Wordmark alone, at the lockup's type size.
    cap_px = ORB_GRID / CAP_RATIO
    for theme, fill in (('light', INK_LIGHT), ('dark', INK_DARK)):
        lay = wordmark_layout(word, cap_px)
        body = word.svg_path(lay.scale, lay.text_x, lay.baseline, fill)
        write(out(f'source-wordmark-{theme}.svg'), svg_doc(lay.w, lay.h, body))
        for s in (1, 2, 4):
            suffix = '' if s == 1 else f'@{s}x'
            save_png(wordmark_png(word, lay, fill, s), out(f'source-wordmark-{theme}{suffix}.png'))

    # Mark alone. The orb carries its own colours, so one file serves light and dark.
    for name, grid in (('mark', g32), ('mark-large', g64)):
        n = len(grid)
        write(out(f'source-{name}.svg'), svg_doc(n, n, orb_svg(grid)))
        for s in (1, 2, 4):
            suffix = '' if s == 1 else f'@{s}x'
            save_png(orb_png(grid, s), out(f'source-{name}{suffix}.png'))

    # Favicons, each size rendered on its own grid: 1px cells up to 48px,
    # then the 32-cell orb at whole-pixel multiples with smooth letters.
    mono = MonoText()
    fav, grids = {}, {}
    for size, spec in ((16, FAV_16), (32, FAV_32), (48, FAV_48)):
        grids[size], fav[size] = favicon_pixel(mono, spec)
    for size in (96, 192, 512):
        fav[size] = favicon_smooth(mono, FAV_32, size // 32, size)
    for size, im in fav.items():
        save_png(im, out(f'favicon/favicon-{size}.png' if size <= 96 else f'favicon/icon-{size}.png'))
    # Apple touch icon: iOS fills transparency with black, so a solid canvas,
    # the orb inset (iOS rounds the corners itself).
    apple = favicon_smooth(mono, FAV_32, 4, 180, bg=CANVAS_LIGHT)
    save_png(apple, out('favicon/apple-touch-icon.png'))
    # Maskable: the orb well inside the central 80% safe circle, on the canvas.
    maskable = favicon_smooth(mono, FAV_32, 10, 512, bg=CANVAS_LIGHT)
    save_png(maskable, out('favicon/icon-512-maskable.png'))
    svg = favicon_svg(grids[32], grids[16])
    write_ico(out('favicon/favicon.ico'), [fav[16], fav[32], fav[48]])
    write(out('favicon/icon.svg'), svg)

    # Next.js App Router file conventions: the ICO for tabs and the touch icon.
    # Deliberately no src/app/icon.svg or icon.png. Chrome takes any other
    # rel=icon over the ICO (Next declares the ICO as 48x48): an SVG it renders
    # once at 16px x the largest screen scale (32px on a Mac, even with the
    # display forced to 1x), a 32px PNG it uses as is, and either way it scales
    # that 32px bitmap down for 1x tabs, which averages the dither into mush.
    # With the ICO alone it shows the native 16 and 32 frames pixel for pixel
    # (checked through chrome://favicon2).
    write_ico(os.path.join(APP, 'favicon.ico'), [fav[16], fav[32], fav[48]])
    save_png(apple, os.path.join(APP, 'apple-icon.png'))

    print(f'palette {PALETTE} (forced), seed "{SEED}" angle {ANGLE} (snapped {SNAPPED})')
    print('kerning (font units):', [(g, k) for g, k in word.kerning if k])
    for rel in files:
        print(f'  public/brand/{rel}  {os.path.getsize(os.path.join(BRAND, rel)):>7,} B')
    print('  src/app/favicon.ico, src/app/apple-icon.png')


if __name__ == '__main__':
    main()
