# Mobile design spec

Canonical reference for the Tarmoto **mobile** app's visual system, plus the
plan to bring `apps/mobile` into alignment with it.

> The mobile app was built before the brand design system was finalised. It
> runs on a legacy cyan-on-dark palette (`#0ED3CF` primary, `#070A10`
> background, system fonts) that predates the canonical cream + ink brand.
> This folder is the single source of truth for what the app should look
> like, and the living plan for getting it there — the same arrangement the
> web companion uses in [`../companion-spec/`](../companion-spec/).

## Source

The design package was handed off by Claude Design and unpacked under
[`source/`](./source/). **Treat those files as read-only** — they're the
frozen reference the migration is implementing against. The user had
`Tarmoto Mobile.html` open when they triggered the handoff, so it is the
primary design.

| File                                                                       | What it is                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`source/HANDOFF_README.md`](./source/HANDOFF_README.md)                   | The design tool's own README. Says read this first.                                                |
| [`source/PROJECT_README.md`](./source/PROJECT_README.md)                   | The Tarmoto design-system README — voice, palette, type, spacing, motion.                          |
| [`source/SKILL.md`](./source/SKILL.md)                                     | The six core rules. The non-negotiables.                                                           |
| [`source/colors_and_type.css`](./source/colors_and_type.css)               | All CSS tokens: palette, semantic surfaces, lines, quality scale, type, spacing, radii, shadow.    |
| [`source/atoms.jsx`](./source/atoms.jsx)                                   | Canonical web atom implementations (shared brand vocabulary).                                      |
| [`source/Tarmoto Mobile.html`](./source/Tarmoto%20Mobile.html)             | The rendered mobile prototype — every screen, in every look/theme/orientation.                     |
| [`source/mobile/`](./source/mobile/)                                       | The mobile prototype's clean React source: `tokens`, `chrome`, `route-svg`, `screens-a..e`, `app`. |
| [`source/map.jsx`](./source/map.jsx)                                       | `TarmotoMap` — the stylised SVG map the immersive screens render over.                             |
| [`source/ui_kits/mobile/mobile.html`](./source/ui_kits/mobile/mobile.html) | The mobile UI kit — a focused subset, handy for one component in isolation.                        |

When you need to know "what should this look like?", read
`source/Tarmoto Mobile.html` and the matching `source/mobile/screens-*.jsx`.
They're plain HTML/CSS/JSX — read them directly; the handoff explicitly says
**don't** render screenshots.

### Vendoring scope

The upstream bundle from Claude Design covers all four products (mobile,
web, marketing, sensor). We vendored only the **mobile-relevant** subset
here; the web subset lives under [`../companion-spec/`](../companion-spec/).
Excluded to keep the repo lean: marketing/web UI kits, the per-component
`preview/` cards, the standalone/offline design-map variants, and the
non-mobile prototypes (`Ride Mode.html`, `App Tour.html`, `Glove Mode.html`,
marketing-site files). The mobile screens are fully captured by
`Tarmoto Mobile.html` + `source/mobile/`.

### Known caveats in the canonical files

- `source/mobile/tokens.jsx` resolves **three looks** — Atlas, Onyx, Rally —
  each in light/dark, plus a portrait/landscape switch and three bottom-nav
  styles. Those are prototype explorations. **Production ships Atlas
  (light), with a night palette for immersive surfaces** (ride mode, the
  welcome hero). Treat Onyx/Rally and the nav-style/orientation toggles as
  out of scope unless a later issue asks for them.
- `source/mobile/tweaks-panel.jsx` and `source/tweaks.jsx` are the
  prototype's dev-only tweak harness — not product UI.
- `colors_and_type.css` uses Sass `@extend` for the `.tarmoto h1/h2/h3`
  rules. That's prototype-only; treat the `.ty-*` rules as the source of
  truth for type.

## The six rules (from SKILL.md)

These override anything below if they conflict.

1. **Cream + ink first.** `#F5EFE6` bg, `#0E0E10` fg. One accent `#FF6A1A`,
   **sparingly (<5% of pixels)**.
2. **Three type families.** Space Grotesk for UI, JetBrains Mono for
   stamps/numbers, Fraunces italic for emotional marketing beats only.
3. **No icon font.** Hand-rolled SVG, Unicode arrows and geometric marks.
4. **Quality is visual vocabulary.** Use `QualityBars` and the Q1–Q5 ramp
   for anything road-quality-related.
5. **Paper on paper.** No drop shadows except on devices and the occasional
   hover. Borders at `rgba(14,14,16,0.10)`.
6. **Never emoji in product UI.** Marketing only.

## What landed in Phase 1 (this work)

The foundation every per-screen phase builds on — added **additively** so no
existing screen changes appearance yet:

- **Tokens** — [`apps/mobile/src/theme/brand.ts`](../../../apps/mobile/src/theme/brand.ts):
  the cream/ink light palette, the night palette, the `#FF6A1A` accent, the
  Q1–Q5 ramp (`QUALITY_COLORS` + labels), radii, spacing, and the intended
  type families. Mirrors `colors_and_type.css` + `mobile/tokens.jsx`. The
  legacy `@/theme` palette is untouched.
- **Atoms** — [`apps/mobile/src/components/brand/`](../../../apps/mobile/src/components/brand/):
  `Stamp`, `QualityBars`, `Chip`, `Metric`, `BrandButton`, and the geometric
  `BrandIcon` set — ported 1:1 from `mobile/tokens.jsx` to React Native +
  `react-native-svg`.

### Fonts — source vendored, linking deferred

Space Grotesk and JetBrains Mono (both variable `.ttf`, OFL 1.1) are checked
in as **source** under
[`apps/mobile/assets/fonts/`](../../../apps/mobile/assets/fonts/), but they
are **not linked yet** — `brand.ts` still uses placeholder family names and
text falls back to the platform sans/mono. Linking them correctly needs
static-weight instancing, Android filename-based resolution, committed native
build artifacts, and on-device validation — none of which can be done/verified
in a headless environment. The fonts
[README](../../../apps/mobile/assets/fonts/README.md) documents the full
dev-machine procedure. Tracked as a Phase 2 follow-up.

## Migration plan

Phased to keep each PR reviewable. Earlier phases unblock later ones. Each
per-screen phase re-reads the relevant `source/mobile/screens-*.jsx` section
and brings the matching app screen onto the brand tokens + atoms.

### Phase 1 — Brand foundation (this PR)

Vendor the spec, add `theme/brand.ts` + the brand atoms, with tests. No
screen migrated yet.

### Phase 2 — Fonts + first screen

1. Bundle Space Grotesk + JetBrains Mono. **Source vendored** under
   `apps/mobile/assets/fonts/` (this PR); actual linking (static-weight
   instancing, Android filename resolution, committed native artifacts,
   device validation) is a dev-machine follow-up — see the fonts README.
2. Migrate **Settings** (`SettingsScreen`) — the narrowest surface (stamp +
   row list + toggles), a clean first proof of the system end-to-end.
   **Done:** the screen is on the brand palette/type, brand `Card` + `Stamp`
   - `Toggle`, with the Settings stack header themed cream (`brandScreenOptions`
     in `RootNavigator`) so it reads consistently. Behaviour and accessibility
     labels are unchanged (tests stay green). The embedded
     `QualityThresholdSlider` / `FuelRangePicker` are migrated too (legible ink
     value text + brand-ramp / accent fills on the light card). Remaining
     follow-up: swap the `material-design-icons` glyphs for hand-rolled
     `BrandIcon`s (rule #3) where equivalents exist.

### Phase 3 — Per-screen sweeps (one PR each, smallest blast radius first)

The mobile prototype's screens map onto the existing app as follows. Screens
without a clean 1:1 today are noted.

| Canonical screen (`source/mobile`)         | App screen(s)                                            | Notes                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `AuthScreen` (welcome / sign in / sign up) | `LinkAccountScreen` + (no dedicated welcome/sign-up yet) | Welcome hero over the map is new; sign-in/up forms map onto the auth flow.                                                        |
| `HomeScreen` (map-first / list-first)      | `HomeScreen` ✅, `CommuteScreen` ✅, `MapScreen`         | Commute card, suggested ride, stat strip, nearby roads. `HomeScreen` + `CommuteScreen` migrated; `MapScreen` + bottom nav remain. |
| `ExplorerScreen` (road quality explorer)   | `MapScreen`, `RoadPreviewScreen`                         | Map + filter chips + segment detail sheet.                                                                                        |
| `PlannerScreen` / `RouteResultScreen`      | `TripCreateScreen`, `TripsScreen`, `TripDayScreen`       | The quick round-trip generator + result is new product surface; align styling.                                                    |
| `RideScreen` (turn-by-turn HUD)            | `NavigationScreen`, `RideActiveScreen`                   | Always-dark immersive HUD.                                                                                                        |
| `HazardScreen` (report)                    | `HazardReportScreen` ✅                                  | Type grid + severity + location card. Migrated (self-contained, no shared deps).                                                  |
| `CrashScreen` (crash detection)            | `CrashAlertOverlay` (component)                          | Full-bleed Q1-red countdown.                                                                                                      |
| `PostRideScreen` (summary)                 | `RideDetailScreen` ✅, `RideScreen` ✅                   | Hero metrics, quality breakdown, elevation, splits, badges. Both migrated; `RideScreen` is the Ride-tab history list + start CTA. |
| `ProfileScreen`                            | `ProfileScreen` ✅, `PersonalRoadMapScreen` ✅           | Stats grid, explored-roads map, settings rows. Both migrated.                                                                     |

Order (smallest blast radius first): **Settings ✅ → Hazard report ✅ →
Emergency contacts ✅ → Offline maps ✅ → Profile ✅ → Post-ride summary ✅ →
Home (in progress) → Road explorer → Ride mode → Crash → Planner/Route**.
The Home phase is split per surface: **`HomeScreen` ✅** landed first (the
self-contained two-card entry point), then **`CommuteScreen` ✅**;
`MapScreen` and the bottom navigation (the brand tab bar with the raised
"Start ride" action) follow as their own steps. `PersonalRoadMapScreen` ✅ (grouped with Profile,
but with no shared `@/components` deps) was a self-contained follow-up.

> **Home note:** `HomeScreen` has no shared `@/components`, no map, no
> quality visuals, and no stack header (tab root), so it migrated in
> isolation. The one-tap "Start commute" CTA reads as a solid **ink** card
> (the primary-action pattern from Profile/RideDetail) rather than an accent
> fill, keeping the accent reserved for small marks (the commute-check icon);
> the new-hazard badge uses `statusFg.danger` with white text.

> **Commute note:** `CommuteScreen` (the hazard-check surface) also uses no
> shared `@/components`. Status banner, hazard-severity, alternative-route,
> and weekly-trend colours all map onto `statusFg.{success,warning,danger}`
> (AA-safe as text/icons on the white card); low-severity hazards have no
> brand "info" tone, so they read as neutral ink. Quality is rendered as
> ink label text (the ramp fails AA as text on cream) — its colour vocabulary
> stays on the map/bar surfaces. The "Start commute" / "Retry" CTAs use the
> ink primary-action pattern; the new-hazard and CLEAR/HAZARD pills keep
> white text on the (AA-safe) status fills.

> **Post-ride note:** `RideDetailScreen` (the past-ride summary) is migrated;
> its shared `RideMetric` label/value atom was made surface-aware (`light?`,
> default legacy) first, so the still-legacy `RideScreen` history list that
> also uses it is untouched until its own phase. The segment-quality
> histogram keeps the Q1–Q5 ramp as bar fills (rule #4, WCAG 1.4.11
> "essential" graphic) with AA-safe ink row labels + counts, plus a hairline
> bar edge so pale ramp buckets stay perceivable on cream. The active lean
> histogram reuses `ACCENT_DARK` to clear 3:1 on the `sunken` track. The
> route-map polyline still uses the legacy ramp helper — re-skinning that
> shared map expression is folded into the Ride-mode phase.
>
> `RideScreen` (the Ride-tab history list + "Start a ride" CTA) is now
> migrated too: it passes `light` to the shared `RideMetric`, so both of that
> atom's callers are on the brand surface. The "Start a ride" card is the
> accent moment (an ink play glyph on an accent disc, ~6.7:1); the
> "Ride in progress" resume card is a solid ink card; row quality renders as
> ink label text (ramp stays off-card). Migrating it also moves the **Ride
> tab root** onto the brand, a prerequisite for flipping the bottom tab bar.

> **Resequencing note:** Hazard report, Emergency contacts, and Offline maps
> were migrated before Profile — each is self-contained (or has only
> Settings-local deps), so they're clean, low-risk sweeps. **Profile**
> followed once its building blocks — `Avatar`, `StatTile`,
> `SharedRidesSection` — were made **surface-aware** (default legacy, opt
> into `light`) so flipping `ProfileScreen` to the cream/ink palette does not
> break the still-legacy `ViewProfileScreen` / `FollowList` that share them
> (the lesson from #725's `QualityThresholdSlider` regression). Those callers
> keep the default-legacy look until their own phase; `ProfileScreen` passes
> `light`. `PersonalRoadMapScreen` has no shared `@/components` deps, so it
> migrated independently right after Profile: the explored-roads map paints
> ridden segments in the accent and unridden in the neutral "unscored" grey,
> the nearby-roads list carries quality on a swatch dot with AA-safe `dim`
> text, and the period filter / stats card use the cream-card brand tokens.

> **Per-screen checklist (learned on #725 / Hazard):**
>
> 1. Grep every caller of each shared component the screen uses; if any
>    caller is still legacy-dark, make the component surface-aware
>    (`light?` prop, default legacy) rather than flipping it globally.
> 2. On the white surface, use AA-safe tones: `dim` for labels/headings (not
>    `mute`), `statusFg.*` for success/warning/danger text+icons (not the
>    quality ramp, which is fill-only), `TOGGLE_OFF_TRACK` for off switches.
> 3. Keep ≥44px glove-first hit targets (`minHeight`/`hitSlop`).
> 4. Theme the screen's stack header with `brandScreenOptions`.
> 5. Preserve copy + accessibility labels so behaviour tests stay green; run
>    the full `pnpm typecheck` (not a path-grepped subset).

### Phase 4 — Cleanup

- Once a screen no longer references the legacy `@/theme` cyan palette,
  prune its dead token usage.
- When the last screen is migrated, fold `theme/brand.ts` into `@/theme`
  and retire the legacy palette.

## Workflow

- One PR per phase. Each PR cites its phase and links the relevant
  `source/mobile/screens-*.jsx` section (line numbers are stable — the
  vendored copy is frozen).
- Tests: where unit tests assert on classes or colours, update them to match
  the brand tokens. The migration must not weaken coverage.
- Keep backend-served units metric; brand surfaces convert for display via
  `@tarmoto/shared` helpers, exactly as the legacy screens do.
