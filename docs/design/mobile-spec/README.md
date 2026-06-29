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

| Canonical screen (`source/mobile`)         | App screen(s)                                                                                                                  | Notes                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `AuthScreen` (welcome / sign in / sign up) | `LinkAccountScreen` + (no dedicated welcome/sign-up yet)                                                                       | Welcome hero over the map is new; sign-in/up forms map onto the auth flow.                                                        |
| `HomeScreen` (map-first / list-first)      | `HomeScreen` ✅, `CommuteScreen` ✅, `MapScreen`                                                                               | Commute card, suggested ride, stat strip, nearby roads. `HomeScreen` + `CommuteScreen` migrated; `MapScreen` + bottom nav remain. |
| `ExplorerScreen` (road quality explorer)   | `MapScreen` ✅, `RoadPreviewScreen` ✅                                                                                         | Map + filter chips + segment detail sheet. Both migrated, plus the `ReviewFormModal` composer opened from RoadPreview. ✅         |
| `PlannerScreen` / `RouteResultScreen`      | `TripCreateScreen` ✅, `TripsScreen` ✅, `TripDetailScreen` ✅, `TripDayScreen` ✅, `JoinTripScreen` ✅, `TripImportScreen` ✅ | The quick round-trip generator + result is new product surface; align styling. Entire Trips cluster migrated. ✅                  |
| `RideScreen` (turn-by-turn HUD)            | `NavigationScreen`, `RideActiveScreen`                                                                                         | Always-dark immersive HUD.                                                                                                        |
| `HazardScreen` (report)                    | `HazardReportScreen` ✅                                                                                                        | Type grid + severity + location card. Migrated (self-contained, no shared deps).                                                  |
| `CrashScreen` (crash detection)            | `CrashAlertOverlay` (component)                                                                                                | Full-bleed Q1-red countdown.                                                                                                      |
| `PostRideScreen` (summary)                 | `RideDetailScreen` ✅, `RideScreen` ✅                                                                                         | Hero metrics, quality breakdown, elevation, splits, badges. Both migrated; `RideScreen` is the Ride-tab history list + start CTA. |
| `ProfileScreen`                            | `ProfileScreen` ✅, `PersonalRoadMapScreen` ✅                                                                                 | Stats grid, explored-roads map, settings rows. Both migrated.                                                                     |

Order (smallest blast radius first): **Settings ✅ → Hazard report ✅ →
Emergency contacts ✅ → Offline maps ✅ → Profile ✅ → Post-ride summary ✅ →
Home ✅ → Road explorer (Map ✅, RoadPreview remaining) → Ride mode → Crash →
Planner/Route**. The Home phase is split per surface: **`HomeScreen` ✅**,
**`CommuteScreen` ✅**, **`MapScreen` ✅** (chrome), and the **bottom
navigation ✅** (the brand tab bar) all landed as their own steps.
`PersonalRoadMapScreen` ✅ (grouped with Profile, but with no shared
`@/components` deps) was a self-contained follow-up.

> **Bottom tab bar:** flipped to the brand once all five tab roots (Home,
> Profile, Ride, Trips, Map) were migrated, so the white bar never sits under
> a still-dark tab root. The bar is white (`raised`) on cream with a `line`
> top border; the active tint is **`ACCENT_DARK`** (the raw accent is only
> ~2.9:1 on white — below the 3:1 floor — so the deepened burnt-orange is
> used; it clears ~5.2:1 for the small label + icon while keeping the accent
> identity), and inactive tabs use the AA-safe `dim`. The bar is **hidden
> entirely on immersive full-screen child routes** (`RideActive` live HUD,
> `Navigate` turn-by-turn) via `getFocusedRouteNameFromRoute` — those are
> edge-to-edge dark surfaces, so the light bar must not stay pinned to them
> (and hiding it is the correct UX regardless). Deeper still-legacy _content_
> stack screens (e.g. ViewProfile, TripCreate) keep their dark headers and
> show the light bar transiently until their own phase; only the tab roots
> gate the shared bar.

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

> **Profile cluster complete:** `ViewProfileScreen` (another rider's profile)
> and the `FollowList` (Followers / Following) are migrated, with their stack
> headers themed cream (`brandScreenOptions`). They mirror `ProfileScreen` and
> pass `light` to the shared `Avatar` / `StatTile` / `SharedRidesSection`
> atoms — which means **those three atoms now have no remaining legacy
> callers**, so their default-legacy StyleSheet is dead code that Phase 4
> cleanup can prune. The follow control reads as a solid ink "Follow" that
> flips to an outlined ink "Following"; badge pills use `raised2` + ink/`dim`
> text (the trophy mark is the one small accent).

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
>
> `TripsScreen` (the **Trips tab root** list) is migrated next, with a cream
> stack header. It shares no `@/components`, so the still-legacy
> `TripCreateScreen` / `TripDayScreen` are untouched. Trip-status pills map to
> AA-safe tones (`ACCENT_DARK` = active, `statusFg.success` = completed,
> `statusFg.warning` = planned, `dim` = fallback); the "Plan a trip" FAB is
> the accent moment (ink glyph/label on accent, ~6.7:1). With Ride + Trips +
> Home + Profile roots now on the brand, only the **Map tab root** remains
> before the shared bottom tab bar can flip.
>
> `MapScreen` (the **Map tab root** explorer) is map-heavy: the MapLibre
> basemap, the quality vector overlay, and the hazard/pass/fun-zone markers
> are their own surface, so the **map colour expressions and
> `MapScreen.helpers` are deliberately untouched** (the quality ramp is the
> essential road-quality encoding, and the helper tests assert those exact
> colours). Only the **chrome floating over the map** is re-skinned, onto the
> dark-overlay-pill pattern: the toggle FABs, the quality/passes/fun-zone
> legends, and the fun-zone detail card become ink pills/cards with cream
> labels, so the ramp swatches and the accent-active toggle pop at ≥6:1.
> `HazardReportFab` is shared with the still-legacy `RideActiveScreen`, so it
> is left as-is. **With all five tab roots now on the brand, the bottom tab
> bar can flip next.**

> **Road preview note:** `RoadPreviewScreen` (the segment-detail screen, the
> rest of the Road-explorer phase) is migrated — header/quality/curviness/
> elevation/hazards/reviews cards onto cream + ink, with a cream stack header.
> The quality breakdown bar + legend keep the Q1–Q5 ramp (visual fills,
> redundant with the labelled %); the headline score renders ink (ramp fails
> AA as text). Hazard severity maps to `statusFg.{danger,warning}` (low →
> neutral ink); interactive text (review links, write/edit actions) uses the
> AA-safe `ACCENT_DARK`; the elevation chart line is `ACCENT_DARK`. The
> `ReviewFormModal` it opens is now migrated too (the fast follow): the
> review composer (rating selector, note/bike inputs, photo strip, submit/
> delete) is on cream + ink, with `sunken` text inputs, `ACCENT_DARK` rating
> stars + interactive accents, an ink submit button, and `statusFg.*` for the
> delete/error/picker states. Photo-thumbnail overlays keep white glyphs on
> their dark scrim. It's only used by RoadPreview, so no blast radius.

> **Trips detail cluster (one PR per screen):** the five trip-detail stack
> screens migrate individually — `TripCreateScreen` → `TripDetailScreen` →
> `TripDayScreen` → `JoinTripScreen` → `TripImportScreen`. **`TripCreateScreen`**
> (the US-7 auto-generate form) is first: the title/region inputs, day /
> daily-distance / road-preference pills, the quality slider, the start-location
> card, and the error banner move onto cream + ink. Selected pills become solid
> ink chips (`invBg`/`invFg`); `sunken` text inputs with `mute` placeholders;
> the "Generate trip" CTA is a solid ink button (ink glyph/label on accent is
> reserved, so the primary action stays ink for AA), and "Import GPX/KML" is an
> outlined ink secondary. It passes `light` to the shared
> `QualityThresholdSlider`; the live-GPS start icon + the "Reset to default"
> link use `ACCENT_DARK` (AA-safe interactive accent on cream), and the error
> banner uses `statusFg.danger` on a `raised2` card. Stack header themed with
> `brandScreenOptions`. No shared `@/components` blast radius beyond the
> already-surface-aware slider.
>
> **`TripDetailScreen`** (the US-7 generated-route output + US-8 invite /
> US-11 closed-pass warning / US-20 GPX export) follows: header, day cards,
> invite, members, and the pass warning move onto cream + ink with a themed
> stack header. Trip status + member-role pills reuse the AA-safe tone map
> from `TripsScreen` (`ACCENT_DARK` active/owner, `statusFg.success`/`warning`
> for completed/planned, ink admin, `dim` fallback). Quality is rendered as a
> **ramp swatch dot + ink/dim label** (header "Quality" metric and each day
> card) — the Q1–Q5 ramp fails AA as text on cream, so the colour lives on
> the swatch (rule #4) and the label stays ink. The closed-pass card drops the
> `qualityAlpha.veryPoor` red wash for a neutral `raised2` card with a
> `statusFg.danger` border + icon; the invite code becomes a mono `sunken`
> stamp; "Share" is an ink button and "Export GPX" an outlined ink secondary.
> It shares no `@/components`, so no blast radius.
>
> **`TripDayScreen`** (the US-7 single-day breakdown — metrics, Start
> navigation, highlights, fuel-range warning, accommodations/POIs near day
> end, and the waypoint timeline) follows: every card moves onto cream + ink
> with a themed stack header. Day quality renders as the **ramp swatch dot +
> ink label** (same pattern as TripDetail); the below-threshold treatment
> keeps the dimmed card + neutral threshold badge. "Start navigation" is the
> ink CTA. The fuel-range warning drops the `qualityAlpha.fair` amber wash for
> a neutral `raised2` card with a `statusFg.warning` border + icon; the FUEL
> waypoint badge/bullets/over-range distances use `statusFg.warning`, and the
> fuel waypoint bubble keeps a warning-bordered neutral bubble. Highlight /
> accommodation / POI icon discs become neutral `raised2` with ink/dim glyphs;
> external-link rows keep their `open-in-new` affordance in `dim`. ≥44px hit
> targets on every tappable row. It shares no `@/components`, so no blast
> radius.
>
> **`JoinTripScreen`** (the US-8 invite-via-code entry form) follows: hero,
> the trip-ID / invite-code inputs, error banner, and Join CTA move onto
> cream + ink with a themed stack header. The two inputs use the mono family
> (`sunken` fields, `mute` placeholders) since both fields are codes; the hero
> icon disc is a neutral `raised2`; "Join trip" is the ink CTA; the error
> banner uses `statusFg.danger` on a `raised2` card. No shared `@/components`,
> so no blast radius.
>
> **`TripImportScreen`** (the US-39 web-companion "Push to mobile" handoff
> landing) closes the Trips cluster: the loading state, hero, shared-trip
> preview card (title / owner / Days·Distance·Stops stats), error banner, and
> "Save to my trips" CTA move onto cream + ink with a themed stack header. The
> stat values use the mono family (stamp numbers); the hero disc is neutral
> `raised2`; the CTA is the ink button; the error banner uses
> `statusFg.danger`. No shared `@/components`, so no blast radius. **With this,
> the entire Trips cluster (Trips list, Create, Detail, Day, Join, Import) is
> on the brand.**
>
> **`AchievementsScreen`** (the US-28/29/30 gamification hub — the entry point
> into Badges / Challenges / Personal road map) is migrated next: title +
> subtitle, the soft "some sources failed" warning, and the three navigation
> hub cards move onto cream + ink with a themed stack header. The hub-card
> icon discs are neutral `raised2` with ink glyphs (the three cards are equal
> nav entries, so no accent moment); the chevron uses `t.faint`; the partial-
> failure banner uses `statusFg.warning`. It shares no `@/components`, so no
> blast radius. Its sub-screens are independent: `PersonalRoadMapScreen` is
> already migrated; `BadgesScreen` / `ChallengesScreen` remain for their own
> phases.
>
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
