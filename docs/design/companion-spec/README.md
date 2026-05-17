# Companion design spec

Canonical reference for the Tarmoto web companion's visual system, plus the
migration plan to bring `apps/companion` into alignment with it.

> The companion was built before the design system was finalised. Several
> surfaces drifted off-palette, mis-applied accent, or kept legacy
> "tarmoto-cyan" patterns that don't match the brand. This folder is the
> single source of truth for what the companion should look like, and the
> living plan for getting it there.

## Source

The design package was handed off by Claude Design and unpacked under
[`source/`](./source/). **Treat those files as read-only** — they're the
frozen reference the migration is implementing against.

| File                                                                               | What it is                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`source/HANDOFF_README.md`](./source/HANDOFF_README.md)                           | The design tool's own README. Says "read the chats first" and explains the package.                                                              |
| [`source/PROJECT_README.md`](./source/PROJECT_README.md)                           | The Tarmoto design-system README — voice, palette, type, spacing, motion, the lot.                                                               |
| [`source/SKILL.md`](./source/SKILL.md)                                             | Six core rules. The non-negotiables.                                                                                                             |
| [`source/colors_and_type.css`](./source/colors_and_type.css)                       | All CSS tokens: palette, semantic surfaces, lines, quality scale, type, spacing, radii, shadow.                                                  |
| [`source/atoms.jsx`](./source/atoms.jsx)                                           | Canonical React-ish atom implementations: Stamp, Heading, Pill, QualityBars, RouteMini.                                                          |
| [`source/Web App v2.html`](./source/Web%20App%20v2.html)                           | The actual web-companion design — every view (Trip Planner, Road Explorer, Ride History, Community, Account), every shared component, exact JSX. |
| [`source/Web App v2 Design Map.html`](./source/Web%20App%20v2%20Design%20Map.html) | A developer-facing reference doc — 21 sections covering tokens, atoms, components, map vocab, layouts. Read alongside the Web App v2 file.       |
| [`source/chats/`](./source/chats/)                                                 | The three design-iteration transcripts. The HANDOFF README explicitly says **read these first** — they capture intent that isn't in the HTML.    |
| [`source/ui_kits/web/web.html`](./source/ui_kits/web/web.html)                     | The web-companion UI kit (focused subset of `Web App v2.html`) — useful when you want one component in isolation.                                |

When you need to know "what should this look like?", read those two HTML
files. They render in any browser if you want to see it, but the source is
already plain HTML/CSS/JSX — you can read it directly.

### Vendoring scope

The upstream bundle from Claude Design is larger than what's checked in
here. We intentionally vendored only the companion-relevant subset:

- **Included** above.
- **Excluded** to keep the repo lean: mobile and marketing UI kits, the
  per-component `preview/` cards, the standalone-source/offline
  variants of the design-map HTML, and the rider-app prototypes
  (`Ride Mode.html`, `App Tour.html`, `Glove Mode.html`,
  `Web App v3 Garage.html`, marketing-site files).

If you need any excluded file during a phase, re-fetch the original
handoff (URL in the chat transcripts) and add the file to `source/` in
that phase's PR.

### Known caveats in the canonical files

These are quirks of the upstream prototype, not bugs we should "fix" in
the vendored copy — note them when porting:

- `colors_and_type.css` uses Sass `@extend` for the `.tarmoto h1/h2/h3`
  rules at the bottom of the file. That's prototype-only syntax; plain
  CSS won't apply it. When implementing the companion's typography,
  treat the `.ty-*` rules as the source of truth and either re-apply
  them as element selectors or wire them up via component classes —
  don't ship the `@extend` block as-is.
- `PROJECT_README.md` references a wider `ui_kits/`, `preview/`, and
  `chats/` tree than what's vendored here. See **Vendoring scope**
  above for what was kept and why.

## The six rules (from SKILL.md)

These override anything below if they conflict.

1. **Cream + ink first.** `#F5EFE6` bg, `#0E0E10` fg. One accent
   `#FF6A1A`, **sparingly (<5% of pixels)**.
2. **Three type families.** Space Grotesk for UI, JetBrains Mono for
   stamps/numbers, Fraunces italic for emotional marketing beats only.
3. **No icon font.** Hand-rolled SVG, Unicode arrows and geometric marks.
   Lucide is the fallback.
4. **Quality is visual vocabulary.** Use `QualityBars` and the Q1–Q5
   ramp for anything road-quality-related.
5. **Paper on paper.** No drop shadows except on devices and the
   occasional hover. Borders at `rgba(14,14,16,0.10)`.
6. **Never emoji in product UI.** Marketing only.

## Tokens

The canonical token set lives in
[`source/colors_and_type.css`](./source/colors_and_type.css). The
companion already declares most of these in
`apps/companion/src/app/globals.css`, but the names + a few values drift
in places (legacy `tarmoto-cyan` aliases, missing `--fg-dim` family,
etc.). The migration audits and reconciles them in **Phase 1**.

## Atoms

Defined in [`source/atoms.jsx`](./source/atoms.jsx) and consumed across
the Web App v2 views. The companion has reasonable equivalents in
`apps/companion/src/components/tarmoto/atoms.tsx` but with drift:

| Atom            | Canonical                                                                           | Companion (current)                                                     |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Stamp`         | Mono 10 px / 700, letter-spacing 1.5, `color = INK_DIM` default                     | Mono 10 px / 700, letter-spacing 1.5 ✓ — but tone keys differ           |
| `Heading`       | Space Grotesk 800, size 28 default, tracking -0.5, line-height 1.05                 | Same family/weight, but sizes diverge across pages                      |
| `Pill`          | bg=INK / color=CREAM default, padding 5/10, radius 999, weight 700, size 11, ls 0.2 | ink/accent/outline/ghost variants — close, **`danger` variant missing** |
| `QualityBars`   | size 6, h = size × 2.2, gap 2, radius 1.5                                           | identical ✓                                                             |
| `Dot`           | colour + size                                                                       | identical ✓                                                             |
| `Mono` / `Card` | Plain wrappers                                                                      | identical ✓                                                             |
| `RouteMini`     | SVG topo + quality-segmented road ribbon (hi-fi)                                    | **not implemented** — companion uses ad-hoc map snippets instead        |

## Components (the parts that drift the most)

The Web App v2 HTML defines five views — each maps to a directory in the
companion:

| Canonical view     | Companion path                                  | Drift summary                                                                                                                                           |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TripPlannerView`  | `apps/companion/src/app/(dashboard)/trips/`     | Folders moved to chip row ✓ (#569). Card / pill styling on trip list still uses legacy tokens.                                                          |
| `RoadExplorerView` | `apps/companion/src/app/explore/`               | Filter + info-layer toggles in place (#570) but on a dark surface that opts out of cream theme — should be cream + accent like the spec, not slate-950. |
| `RideHistoryView`  | `apps/companion/src/app/(dashboard)/rides/`     | Table styling drifts; mono/numeric columns aren't tabular-mono.                                                                                         |
| `CommunityView`    | `apps/companion/src/app/(dashboard)/community/` | Card grid uses placeholder layout; should mirror canonical signature row pattern.                                                                       |
| `AccountView`      | `apps/companion/src/app/(dashboard)/settings/`  | Settings forms diverge from canonical "stamp + row" patterns.                                                                                           |
| `TweaksPanel`      | _none_                                          | Dev-only — not in scope for product migration.                                                                                                          |

## Migration plan

Phased to keep each PR reviewable. Earlier phases unblock later ones.

### Phase 1 — Token reconciliation (1 PR)

- Walk `apps/companion/src/app/globals.css` and reconcile every
  `--color-*`, `--font-*`, `--container-*` against
  [`source/colors_and_type.css`](./source/colors_and_type.css).
- Remove obsolete `tarmoto-cyan` aliases (after a search-and-replace
  sweep on the few remaining call sites — most have already been migrated
  to `accent` by #583).
- Add the missing `--line` / `--line-strong` / `--fg-dim` / `--fg-mute`
  / `--fg-faint` semantic vars so subsequent phases can reference them
  by name.
- Confirm `--accent: #FF6A1A`, all five `--q1..q5` values match
  byte-for-byte. Snapshot mismatches in a checklist inside the PR.

### Phase 2 — Atoms migration (1 PR)

- `Pill`: add `danger` variant (transparent + Q1 border) — spec
  requires it for destructive actions; companion currently rolls its
  own at each call site.
- `Heading`: align default sizes with the canonical 28 / 22 / 18 ladder.
- `Stamp`: match canonical tone keys (`dim` / `ink` / `accent` /
  `on-dark` / `on-dark-dim`) — they're close already.
- `RouteMini`: port the canonical SVG ribbon component so the trip
  cards stop rendering bespoke MapLibre snapshots for their preview.
- Pull `QUALITY_COLORS` import path into a single canonical export so
  the trip / hazard / road-segment consumers all agree.

### Phase 3 — Per-view sweeps (1 PR each)

In the order below, smallest blast radius first. Each PR re-reads the
relevant `Web App v2.html` section and brings the companion view into
alignment.

1. **Settings (`AccountView`)** — narrowest layout, smallest surface.
2. **Ride History (`RideHistoryView`)** — fixes the table styling and
   tabular-mono numerics.
3. **Community (`CommunityView`)** — card grid + signature row.
4. **Trip Planner (`TripPlannerView`)** — the most complex view. Likely
   2 PRs (list page + planner page).
5. **Road Explorer (`RoadExplorerView`)** — the spec is cream-themed
   like every other view; the companion's current dark-canvas opt-out
   (#583) was a contrast workaround, not the canonical design.

### Phase 4 — Cleanup (1 PR)

- Delete any remaining `tarmoto-cyan` aliases once no call sites are
  left.
- Move shared `RouteMini` / `RoadPreviewCard` / `MetricBrick` into
  `apps/companion/src/components/tarmoto/` so future surfaces import
  them directly instead of cloning.
- Update `docs/design/brand/README.md` to point at this folder as the
  companion-specific extension of the brand reference.

## Workflow

- One PR per phase. Each PR cites its phase in the description and
  links the relevant section of `source/Web App v2.html` (line numbers
  are stable since the vendored copy is frozen).
- Manual verification: every PR should screenshot the affected surface
  side-by-side with the canonical render. The user has the design
  package and can render the source HTML locally if needed.
- Tests: where unit / E2E tests assert on classes or colors, update
  them to match the new tokens. The migration should not weaken test
  coverage.
