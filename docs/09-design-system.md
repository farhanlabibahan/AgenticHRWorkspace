# 09 · Design system

Source's interface language. Every screen in the product and on the marketing
site is built from the rules below. Tokens live in `src/app/globals.css`,
components live in `src/components/ui/`, and the live specimen is at `/system`.

The system comes from two references:

- **The calm-app reference** (the mobile "Explore / Letting Go" screens): a warm
  near-white canvas, white surfaces without borders, black pill for the one
  primary action, recessed input fields, small regular-weight type, and color
  that only appears in gradient orbs.
- **ElevenLabs UI** (ui.elevenlabs.io): shadcn-style primitives built on Geist,
  a 36px control height, a 4px grid, and the orb as the system's signature.

## 1 · Principles

1. **Value, not lines.** Surfaces separate by lightness, not by borders. The
   canvas is warm off-white. A surface sits one step lighter and has no border.
   An input sits one step darker. Borders are only used for hairline dividers
   *inside* a surface.
2. **The interface is grey; the content has color.** The UI is achromatic.
   Color comes from two places only: the **orb**, which gives an entity
   (posting, candidate, stage) its identity, and **status signals**, used in
   small doses as a 6px dot or a short colored label. Buttons, tabs, and nav are
   never colored.
3. **One black thing.** Each view has at most one filled-ink primary action.
   Every other control is white or transparent.
4. **The shape says what it does.** Pill: you press it (buttons, chips,
   segmented tabs, nav items, badges). Soft rectangle: you type in it
   (inputs, selects, textareas). Rounded rectangle: it holds things (cards,
   panels, dialogs).
5. **Hierarchy comes from size and ink, not weight.** There are two weights:
   400 and 500. There is no bold in the product.
6. **Quiet type, generous air.** Small type, big gaps. When something needs
   more emphasis, give it more space before you give it a bigger size.

## 2 · Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F5F4F2` | `#0F0F0E` | Page background |
| `surface` | `#FFFFFF` | `#1A1A19` | Cards, chips, secondary buttons, menus, nav pill |
| `recessed` | `#EDECE9` | `#232321` | Inputs, tracks (switch, segmented, progress) |
| `muted` | `#F2F1EF` | `#262624` | Fills *on* a surface: badges, hovered rows, tonal buttons |
| `ink` | `#0A0A0A` | `#F5F4F2` | Primary text, primary action fill |
| `ink-2` | `#6B6A67` | `#A3A29E` | Secondary text. AA on canvas (4.9:1), surface (5.4:1), recessed (4.6:1) |
| `ink-3` | `#9B9A96` | `#6B6A67` | Placeholder, disabled, and decorative text only. Never body copy |
| `line` | ink / 7% | white / 8% | Hairline dividers inside a surface |
| `line-strong` | ink / 14% | white / 14% | Focus ring, dashed drop zones |

**Status.** These are muted and used in small doses. Use them as text or a 6px
dot, and only as a background at /10:
`positive #3F8F5F` · `caution #B7791F` · `critical #D14D41` · `info #4F7FB8`.

**Orb.** The orb is Orbkit's SHDR-14, a lit plasma dome dithered to two tones
through an 8×8 Bayer matrix. It is vendored in `components/ui/shdr-14.tsx`
under the MIT license. Each palette is an ink/paper pair, and the seed is the
entity's id, so a posting always gets the same orb:
`ember` · `lavender` · `iris` · `prism` · `glacier` · `sage`.
At 64px and larger the orb is the live WebGL shader. Below 64px it is a
static dithered sphere drawn on a 2D canvas, because browsers cap live WebGL
contexts at about 16 per page and lists can hold dozens of orbs. Avatars use
the `soft` variant, which is mostly paper so the initials stay legible.

Hover is `ink / 4%` on canvas and `muted` on a surface. Pressing a pill scales it
to 0.98.

## 3 · Typography

**Geist** for everything. **Fragment Mono** only for machine values: API
keys, IDs, code, tokens. Mono is never used for labels, dates, or badges.

The scale has two bands. In the **UI band** (11–20) the steps are small
(×1.08–1.14), because dense interfaces need fine gradations. In the **display
band** (24–72) the steps are large (×1.25–1.35), because headings need contrast.
Every line height sits on the 4px grid.

| Token | Size / line | Tracking | Weight | Use |
|---|---|---|---|---|
| `text-2xs` | 11 / 16 | 0 | 400 | Captions, nav labels under icons, counts |
| `text-xs` | 12 / 16 | 0 | 400–500 | Section labels, badges, table headers, meta |
| `text-sm` | 13 / 20 | 0 | 400–500 | Secondary body, buttons, list items, form labels |
| `text-base` | 14 / 20 | 0 | 400 | Default body |
| `text-md` | 16 / 24 | −0.005em | 400–500 | Lead text, card titles |
| `text-lg` | 18 / 24 | −0.01em | 500 | Panel titles |
| `text-xl` | 20 / 28 | −0.015em | 500 | Page titles (the reference's "Explore") |
| `text-2xl` | 24 / 32 | −0.02em | 400 | Marketing sub-heads, big stats |
| `text-3xl` | 32 / 36 | −0.025em | 400 | Marketing section heads |
| `text-4xl` | 44 / 48 | −0.03em | 400 | Marketing H1 (tablet) |
| `text-5xl` | 56 / 60 | −0.035em | 400 | Marketing H1 (desktop) |
| `text-6xl` | 72 / 72 | −0.04em | 400 | Hero statements |

Rules:
- Headings of 20px and under use 500. Display sizes (24 and up) use 400, because
  size already carries the hierarchy.
- Write everything in **sentence case**. Nothing is uppercase, and there is no
  letter-spaced micro type.
- A text block has at most three inks: `ink`, `ink-2`, `ink-3`.
- Reading measure is 65ch at most (`max-w-prose` / 640px).
- Numbers in tables and stats use `tabular-nums`.

## 4 · Space & grid

The base unit is **4px**. The spacing steps actually used are
4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 · 64 · 96.

| Relationship | Gap |
|---|---|
| Label → its value / control | 4–6 |
| Items within a group (chips, buttons in a toolbar) | 8 |
| Cards in a grid | 12 |
| Blocks within a section | 16 |
| Sections of a page | 32 |
| Marketing sections | 96–128 |

**Gutters.** 16 on mobile, 24 on the app's content area (`px-6`), and 32 on
marketing at lg.
**Widths.** 640 reading · 560 forms · 1200 app content · 1120 marketing grid.
**Card grid.** `grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3`. The
reference's 2-up grid is this grid at phone width.
**Nested radius.** An inner radius equals the outer radius minus the padding. A
12px card with 4px padding holds 8px children.

## 5 · Components are sized from the type

A control's height is its line height plus padding, always on the 4px grid, and
it shares that height with the controls it sits next to. A button, input,
select, and chip in the same toolbar are all the same height.

| Size | Height | Text | Pill padding-x | Icon | Where |
|---|---|---|---|---|---|
| `xs` | 24 | 12/16 | 10 | 12 | Inline in rows and cards (the reference's count badge) |
| `sm` | 32 | 13/20 | 12 | 14 | Chips, filters, secondary actions ("See more") |
| `md` | 36 | 13/20 | 16 | 16 | **App default**: buttons, inputs, selects |
| `lg` | 44 | 14/20 | 20 | 16 | Primary CTA, marketing, auth, mobile ("Start session") |

A pill's padding-x is about 0.4 × its height. Icon-only buttons are circles
with the same height as the others: 32 / 36 / 44.

**Radii.** `full` for pills and avatars · `8` for fields · `12` for cards and
panels · `16` for dialogs and sheets · `24` for hero media.

**Elevation.** There are three levels, and only floating elements get a shadow.
- *Flat*: the canvas.
- *Raised*: a surface on the canvas. No border, no shadow.
- *Floating*: menus, popovers, dialogs, the mobile nav pill.
  `shadow-float` = `0 12px 32px -12px rgb(0 0 0 / .14), 0 0 0 1px rgb(0 0 0 / .04)`.

**Stacking.** Floating things portal to `<body>`, so their z-index is global:
fixed chrome `z-50` · dialogs and the profile drawer `z-[300]` · menus
`z-[350]` · toasts `z-[400]`. Menus sit above dialogs because they open
*inside* them. A menu below the drawer opens invisibly behind it.

## 6 · Buttons

| Variant | Look | Use |
|---|---|---|
| `primary` | ink fill, surface text | The one main action in a view |
| `secondary` | surface (white) fill, ink text | Everything else on the canvas ("See more") |
| `tonal` | muted fill, ink text | Secondary actions *inside* a white surface |
| `ghost` | transparent, ink-2 text; hover gets a fill | Toolbar and row actions, "Cancel" |
| `critical` | critical fill, white text | A destructive confirm, only inside a dialog |

Every button is a pill and uses weight 500. Press: 0.98 scale over 120ms. Focus:
a 2px `line-strong` ring with a 2px offset. Disabled: 40% opacity. A loading
button keeps its width and swaps its label for "Working…".

## 7 · Inputs

A field is a **recessed soft rectangle** with no border and an 8px radius, and
its height matches the button tier. On focus (`is-focused`) the field turns
`surface` with the selected state's 1px `selected` stroke, drawn inset so no
scrolling parent can clip it, and keeps its layout. A field that fails the
browser's validation (`required`, `type="email"`…) gets a 1px `critical` stroke
and a small note under it (`FieldValidation`, in the root layout), never the
browser's own bubble.
Fields opt out of password-manager overlays (`noAutofill`) everywhere except
sign-in and the candidate-facing pages. The placeholder uses `ink-3`. The label
sits above the field in 13px `ink` at 500, 6px above. Help and error text sits
below in 12px (`ink-2` / `critical`). Search is a field with a leading 16px
icon.

## 8 · Patterns

- **Selected state.** A selected card, tile, chip, or option sits on a surface
  with a **1px gray stroke** (`is-selected`: an inset `--color-selected`, ink
  at 20%). Never mark selection with a heavy ink ring or an ink fill. Inside a
  white surface, the unselected options sit on `muted` so the white selected
  one still reads. Add `selectable` to animate the change. Location indicators
  (the nav pill, the segmented thumb) are white pills that slide, not strokes.
- **Chip / filter.** A white pill (`sm`) in `ink-2`. When selected it gains
  the 1px stroke and full `ink`. A row of chips scrolls horizontally on
  mobile.
- **Segmented control.** A recessed pill track holding a white pill thumb.
  Use it for 2–4 views of the same data (Active / Archived).
- **Badge.** An `xs` pill: `muted` on a surface, `surface` on the canvas. A
  status badge adds a 6px dot. It is never outlined and never in mono.
- **Card.** A surface with a 12px radius and 20px padding (16 when it sits in a
  grid). Its title is `text-md` at 500 and its meta is `text-sm` in `ink-2`.
  An interactive card lifts to `shadow-float` on hover.
- **List.** One surface card holds the rows, divided by `line`. Each row is
  52–64px with 16px padding-x. There are no per-row borders.
- **Table.** It sits inside a card. The header is 12px `ink-2` at 500 in
  sentence case, on the surface itself, without a filled header row.
- **Section label.** 12px `ink-2` at 500 in sentence case ("Made for your
  moment"), with 12px of space before its content.
- **Empty state.** A large orb (96px), a `text-md` title, a `text-sm` `ink-2`
  line, and at most one `secondary` button, all centered on the canvas with no
  dashed box.
- **Avatar.** A soft orb (low-chroma glacier/sage) holding the initial in 500
  `ink`.
- **Navigation.** On desktop, a canvas-colored sidebar with no border. Nav
  items are pills, and the active item is `surface`. On mobile, a floating white
  pill nav with icons over 11px labels, as in the reference.

## 9 · Motion

No animation blurs. `filter: blur()` makes the GPU redraw the element every
frame, which shows as lag on anything large (the drawer, a table). Motion is
fades, rises, slides and scales. A static blur that doesn't animate, like a
frosted-glass `backdrop-blur`, is fine.

Motion follows the transitions.dev scale. Pick a token by what the motion is
for, not by its number. The scale was retuned on 2026-09-25 to feel smoother: an
ease-out cubic in place of the quint, and each duration about a quarter longer.
Use the tokens (`duration-[var(--duration-fast)]`), never a copied number, so
the next retune reaches everything. Hover colour changes stay quick (120ms);
they are feedback, not motion. The tokens live in `globals.css` and the wrappers in
`components/ui/motion.tsx`.

| Token | Value | For |
|---|---|---|
| `--duration-quick` | 200ms | menu/modal close, text swap, tooltip in |
| `--duration-fast` | 320ms | menu open, icon swap, tabs sliding |
| `--duration-medium` | 420ms | panel close, toggle, arrow nudge |
| `--duration-slow` | 480ms | panel open, skeleton→content reveal |
| `--duration-very-slow` | 600ms | digits, text reveal, success check |
| `--ease-smooth` | `cubic-bezier(0.33, 1, 0.68, 1)` | open/close, slides, position |
| `--ease-smooth-out` | `cubic-bezier(0.32, 0, 0.67, 0)` | an exit that replays its entrance (the smooth curve reversed) |
| `--ease-bounce` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | pops: digits, badges, toggle |

The patterns and where they live:

- **Menus** grow from the trigger (scale 0.97→1). They close faster (0.99).
- **The homepage's phone menu** folds the nav pill down to its close button,
  centered: the menu icon swaps to close in place (the X pops in on
  `--ease-bounce`) while the logo and Get started fade and the pill folds on
  grid columns. It is the one place that runs snappier than the scale: a
  quick gesture should answer the tap at once, so it has its own timing
  (`--menu-dur` 280ms, an expo-out `--menu-ease`, a 30ms stagger). Closing
  replays the whole opening backwards on the reversed curve: the rows drop
  out last-first, then the pill unfolds and the sheet fades.
- **A Radix exit needs its own keyframes name.** Reusing the entrance
  reversed makes Radix unmount at once, so the exit never plays (the phone
  menu and every dialog's scrim did this; both use `t-sheet-out` now).
- **Segmented control and sidebar nav:** the pill slides to the target, and
  the sidebar pill moves on click.
- **Buttons with pending labels** use `TextSwap`, so the label fades through
  Save → Saving….
- **`CopyButton`** swaps its icon to a check and its label to "Copied".
- **`Checkbox`** draws its check. **`Switch`** overshoots and settles.
- **`NumberPop`** re-enters only the digits that changed.
- **The profile drawer** uses the panel reveal: 480ms in (`--duration-slow`), and every exit
  (X, Escape, backdrop, links out, browser Back) plays it backwards: 480ms
  on the reversed curve. It opens on the click, before the profile loads,
  and a page load paints it already open (`components/drawer-host.tsx`).
  Only `translate` and `opacity` animate.
- **Dialogs** grow like menus (0.97→1) over a fading scrim. A dialog that
  makes something (the share link) shows a miniature of the result building,
  with `ThinkingStates` under it, for at least 1.2s. Faster than that, it
  flashes past and reads as a glitch.
- **Empty states** rise line by line, 40ms apart. Skeletons pulse, and the
  content that replaces them carries `t-reveal`.
- **Accordions** grow on grid rows while the body fades in.
- **Failed submits** shake the fields (`useShake`).
- **Trailing arrows** nudge 2px on hover (`t-learn-arrow`).
- **AI in flight:** `ThinkingStates` cycles shimmering status lines, and
  answers arrive through `StreamingText`.

Every animation respects `prefers-reduced-motion`.

## 10 · Assistant

The bot is the assistant's one face (`components/ui/bot.tsx`, from
bot-avatars): a lavender form from the orb palette, with saturation calmed.
Its state has to be truthful:

- **idle** when the assistant is ready.
- **working** while a request is in flight. Pair it with `ThinkingStates`.
- **sleeping** when AI isn't on for this server. Where nothing can run, leave the AI
  surface out instead of showing a sleeping bot, and never tell users about keys.

When the bot is present, it replaces the Sparkles icon; don't use both.

## 11 · Charts

Charts are dithered: ink dots on an 8×8 Bayer threshold over a faint dotted
track (`components/ui/dither.tsx`). Density ramps to solid at the fill's
leading edge, from 0.5 in bars and rings and 0.55 in columns. Bars sit on a
2px pitch with a half-pixel gap between dots; columns and rings on a 3px
pitch. Each chart eases in over 550ms when it scrolls into view. Each chart
has its own dials in Storybook's Playground → Dither.

- `DitherBar` for counts and funnels.
- `DitherColumns` for per-stage durations.
- `DitherRing` for rates and progress.

Charts are ink only, with no color. They ease in when they scroll into view,
tween from their old values when the data changes, and draw the final frame
straight away under reduced motion.

## 12 · Logo and favicon

The logo is the ember orb (the homepage's `<Orb palette="ember" />`) beside
"Source" in Geist Medium, outlined. The orb is 2.2 times the cap height, and
the gap to the S is 0.28 of the orb's diameter. The favicon writes `SRC` in Fragment Mono across the
orb, with the dither cleared around the letters. It is only for icons. Every
size is rendered on its own pixel grid, never scaled down from a bigger
image. The files and usage rules are in `public/brand/README.md`. They are
generated by `scripts/brand/`, so change the script and rerun it rather than
editing the files.
