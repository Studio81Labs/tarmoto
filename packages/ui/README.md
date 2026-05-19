# @tarmoto/ui

Reusable React component library for the Tarmoto **Web App v2** design
language — cream/ink palette, JetBrains Mono stamps, five-stop quality
vocabulary, paper-on-paper hairlines.

Built primarily for the Next.js companion app, but structured so the
marketing site and any future web surface can adopt the same primitives
without duplication.

## Spec

Sourced from `design/Web App v2 Design Map.html` (the design bundle
shipped from Claude Design). Section numbers in component comments
reference that document.

## Setup

The package ships **Tailwind-styled** components. Components reference
token names (`bg-ink`, `text-quality-q4`, `border-line`, …) that the
consumer must register with Tailwind v4. Two ways:

**1) Tailwind v4 consumers (companion, marketing):**

```css
/* app/globals.css */
@import "tailwindcss";
@import "@tarmoto/ui/theme.css";
```

That `@theme` import wires `cream`, `ink`, `accent`, `quality-q1…q5`,
`fg-dim/mute/faint`, `line/line-strong`, plus the Space Grotesk /
JetBrains Mono / Fraunces font stacks into Tailwind.

**2) Non-Tailwind consumers:**

```css
@import "@tarmoto/ui/tokens.css";
```

This exposes the same palette as `--tm-*` CSS variables and loads the
Google Fonts.

## Components

### Atoms (`@tarmoto/ui` · `./atoms`)

| Component     | Spec | Notes                                                |
| ------------- | ---- | ---------------------------------------------------- |
| `Stamp`       | §07  | JB Mono 11/700 · 1.5 letter · uppercase · 5 tones    |
| `Mono`        | §07  | Tabular numerics                                     |
| `Heading`     | §07  | Space Grotesk 800 · sm/md/lg/xl                      |
| `Pill`        | §08  | primary · accent · ghost · danger · on-dark          |
| `Dot`         | §07  | 6–14 px circle for status                            |
| `QualityBars` | §10  | Five-bar quality glyph · palette-aware · onDark flag |
| `TarmotoMark` | —    | Brand glyph (T-with-road)                            |

### Controls (`./controls`)

| Component          | Spec | Notes                                                              |
| ------------------ | ---- | ------------------------------------------------------------------ |
| `Button`           | §17  | sm/md/lg × primary/accent/secondary/ghost/danger/on-dark + loading |
| `Toggle`           | §09  | 34 × 20 ink track · accent thumb                                   |
| `SegmentedControl` | §09  | 2–4 mutually-exclusive options                                     |
| `Slider`           | §09  | Single-handle, accent thumb ringed in ink                          |
| `RadioCardGroup`   | §09  | Stacked cards with help text                                       |
| `NumberGrid`       | §09  | Equal-flex chips for days/gears                                    |
| `SwatchPicker`     | §09  | Curated colours only — never a free hex picker                     |

### Components (`./components`)

| Component             | Spec | Notes                                                        |
| --------------------- | ---- | ------------------------------------------------------------ |
| `Card`                | §11  | default · paper · paper-2 · ink                              |
| `MetricTile`          | §12  | KPI brick: stamp → number → unit → delta                     |
| `RoadPreviewCard`     | §13  | Signature trip-planner row, with elevation + q-strip         |
| `NavRail`             | §14  | 220 px ink rail, numbered nav, slottable footer              |
| `NavRailContribution` | §14  | Cream-tinted "YOUR CONTRIBUTION" callout                     |
| `DataTable`           | §15  | Paper header · cream rows · mono numerics                    |
| `TweaksPanel`         | §16  | Floating display-prefs card (mapMode/palette/density/accent) |
| `RouteMini`           | —    | Hand-drawn SVG route preview (from `atoms.jsx`)              |

### Feedback (`./feedback`)

| Component | Spec | Notes                                                      |
| --------- | ---- | ---------------------------------------------------------- |
| `Alert`   | §18  | info · success · warning · danger · neutral, compact flag  |
| `Tooltip` | §19  | label · data · coach · 4 placements · 200 ms hover delay   |
| `Toast`   | §20  | Transient feedback · 4 intents · optional 4 s progress bar |

## Conventions

- **One primary per surface.** A card, panel, or dialog gets exactly one
  ink (or accent) button. Companions are secondary or ghost.
- **Match button colour to its surface.** Ink button on cream. Accent
  button on ink. Never accent on cream as the primary action.
- **QualityBars are sacred.** Always five bars, always palette-aware,
  always filled left to right. Don't recolour or reorder them.
- **No emoji in product UI.** Unicode arrows / geometric marks only
  (→, ⟵, ●, ✓, ⚠).
- **Numbers always use Mono** (`tabular-nums`).
