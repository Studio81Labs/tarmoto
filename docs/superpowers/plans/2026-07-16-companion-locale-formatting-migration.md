# Companion Locale-Formatting Migration (PR 3 + PR 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every locale-sensitive display call site in `apps/companion` through the merged formatting seam (`useFormat()` / `getServerFormatters()`), delete the legacy helpers, and land the ESLint guard — making EU users actually see localized numbers, dates, and times.

**Architecture:** Pure mechanical migration against the shipped seam (PR #1012, spec `docs/superpowers/specs/2026-07-16-companion-locale-formatting-design.md` §4/§5/§7). Client components call `useFormat()`; server components (`rsc`) call `await getServerFormatters()`; pure lib modules take a `Formatters` parameter injected by their component callers. Two small shared additions land first (`durationCompact`, `formatCount` locale param). Helpers are deleted as their last importer migrates; the ESLint guard lands last and locks the door.

**Tech Stack:** `@tarmoto/shared` `Formatters` (Intl-based), Next.js App Router, vitest (jsdom), Playwright.

## Global Constraints

- The seam is the ONLY formatting path when this plan completes: no `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`/`new Intl.NumberFormat`/`new Intl.DateTimeFormat` outside `src/format/` (enforced by Task 8's ESLint rule).
- Component tests render WITHOUT `FormatProvider`, so `useFormat()` falls back to the context default `createFormatters({locale:"en", units:"metric"})` (en/UTC/metric) — deterministic. Update test literals to that output (e.g. en-GB `"18 Apr 2025"` becomes `"Apr 18, 2025"`).
- `Formatters` vocabulary (from `@tarmoto/shared`): `integer, number, decimal(v,digits), percent(fraction), date, shortDate, monthYear, time, dateTime, dateRange, calendarDate, calendarDateRange, relativeTime, duration, distanceKm, distanceM, speed, elevation, temperature, splitDistanceKm, splitSpeed, splitElevation` (+ `durationCompact` after Task 1).
- Unit-aware formatters already read the account/store-synced unit system via the provider — call sites must DROP their own `unitSystem` store reads where the only use was formatting.
- Companion CI typechecks test files: run `pnpm typecheck` in `apps/companion` after every task. Backend untouched. Double quotes.
- Conventional commits, lowercase subjects. PR 3 = Tasks 1–3 (`refactor(companion)` series); PR 4 = Tasks 4–8.
- Branch from current `main` (`df9f0f2d` or later).
- **Behavior changes are intended and accepted** (spec §Risks "copy churn"): hardcoded en-GB/en-US shapes become resolved-locale shapes; UTC-pinned billing dates become viewer-timezone instants; TripCollaborateModal's forced-24h "Yesterday, 18:40" becomes locale `relativeTime`; the ride-header weekday (en-GB `weekday:"short"`) is dropped (`date()` has no weekday); grouping separators appear where `toFixed` had none; `splitDistanceKm` keeps one decimal where `formatKmValue` rounded to whole km, and has NO sub-1km meters switch (a <1 km aggregate renders "0.4 km", not "400 m" — adjudicated acceptable in M2 review; follow-up `splitDistanceM` only if product asks). Do not "fix" these back.

## The Transformation Recipe (applies to every task)

**Context acquisition — exactly one of:**

```tsx
// [client] file ("use client" present)
import { useFormat } from "@/format/FormatProvider";
// inside the component:
const format = useFormat();
```

```tsx
// [rsc] file (server page/component, no "use client")
import { getServerFormatters } from "@/format/server";
// inside the async component:
const format = await getServerFormatters();
```

```ts
// [lib] pure module — inject via parameter, callers pass their `format`:
import type { Formatters } from "@tarmoto/shared";
export function buildX(args: X, format: Formatters): string { ... }
```

`[leaf]` components (no directive) inherit the caller's context: if all callers are client, use `useFormat()`; if any caller is a server component (only `components/public-share.tsx`), take `format: Formatters` as a prop instead.

**Call-site mappings (old → new, verbatim):**

| Old                                                                          | New                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `x.toLocaleString()` (counts, XP, elevation totals)                          | `format.integer(x)`                                                                                        |
| `x.toLocaleString(locale, opts)` (useNumberFormat)                           | `format.number(x, opts)`                                                                                   |
| `new Date(iso).toLocaleDateString()`                                         | `format.date(iso)`                                                                                         |
| `formatDate(iso)` (utils, en-GB)                                             | `format.date(iso)`                                                                                         |
| `formatShortDate(iso)` (utils, en-GB)                                        | `format.shortDate(iso)`                                                                                    |
| en-GB `{weekday,day,month,year}` render                                      | `format.date(iso)` (weekday dropped — accepted)                                                            |
| `toLocaleDateString(undefined, {month:"short", year:"numeric"})`             | `format.monthYear(iso)`                                                                                    |
| `formatRelativeTime(iso)` (utils + TripCollaborateModal copy)                | `format.relativeTime(iso)`                                                                                 |
| `formatDuration(min)`                                                        | `format.duration(min)`                                                                                     |
| `formatDurationCompact(min)`                                                 | `format.durationCompact(min)` (Task 1)                                                                     |
| `formatDistance(km, units)`                                                  | `format.distanceKm(km)`                                                                                    |
| `formatDistanceFromMeters(m, units)`                                         | `format.distanceM(m)`                                                                                      |
| `formatKmValue(km)` (number-only string)                                     | `format.splitDistanceKm(km).value`                                                                         |
| `splitFormattedDistance(km, units)`                                          | `format.splitDistanceKm(km)`                                                                               |
| `splitFormattedSpeed(kmh, units)`                                            | `format.splitSpeed(kmh)`                                                                                   |
| `splitFormattedElevation(m, units)`                                          | `format.splitElevation(m)`                                                                                 |
| display `x.toFixed(1)` / `x.toFixed(2)`                                      | `format.decimal(x, 1)` / `format.decimal(x, 2)`                                                            |
| `` `${Math.round(r * 100)}%` `` (display text)                               | `format.percent(r)` (pass the FRACTION `r`)                                                                |
| `` `${m.toLocaleString()} m` `` / elevation strings                          | `format.elevation(m)`                                                                                      |
| speed strings `` `${v} km/h` ``                                              | `format.speed(v)`                                                                                          |
| `Intl.NumberFormat("en-US").format(n)` (ride-embed)                          | `format.integer(n)` (via injected param)                                                                   |
| closure window (`formatClosureWindow`)                                       | `format.calendarDateRange(start, end)`; open-ended → `format.calendarDate(start)` + existing "onward" copy |
| `previewDay` (ClosuresPanel `Intl.DateTimeFormat('en-US',{timeZone:'UTC'})`) | `format.calendarDate(previewDate)`                                                                         |
| subscription `formatDate` (UTC-pinned en-US)                                 | `format.date(iso)` (instant — viewer tz, per audit)                                                        |
| date-only strings (`SegmentTrendChart` `p.date`, stats heatmap `cell.date`)  | `format.calendarDate(dateStr)`; chart axis ticks → `format.monthYear(dateStr)`                             |
| bare `formatCount(n)` (shared)                                               | `formatCount(n, format.locale)` (Task 1 adds the param)                                                    |

**Pinned exclusions — do NOT migrate (from the audit; cite in PR body):**

- Technical `toFixed` (SVG paths, map URL/tile params, dedupe keys, coordinate labels, GPX export): `discover/page.tsx:70-74`, `DiscoverMap.tsx:131`, `ZoneListPanel.tsx:131`, `QualityMap.tsx:175-182`, `rides/[rideId]/page.tsx:900`, `rides/road-map/page.tsx:333-334`, `trips/planner/page.tsx:861,4072`, `TripImportDialog.tsx:297`, `TripPlannerMap.tsx:2998`, `MapCanvas.tsx:434-441`, `RouteOutlineSvg.tsx:78`, `collection-route-atoms.tsx:31`, `CollectionsDiscover.tsx:35`, `gpx-kml-import.ts:86,96,100,258`, `ride-compare.ts:276,333`, `segment-preview.ts:33`, `trip-export.ts:97`, `ride-detail.ts:173`, `planner/api.ts:758`.
- CSS width/height percent styles (not locale text).
- Timezone-DETECTION `Intl.DateTimeFormat().resolvedOptions().timeZone` (`settings/notifications/page.tsx:68,155`, `PreferencesSync.tsx`, `FormatPrefsSync.tsx`) — infrastructure, and not `new`-constructed so the guard permits it.
- `formatJoinedLabel` (shared) — deliberate UTC month-bucketing, stays.
- `BestRoadsSchemaOrg.tsx` JSON-LD numbers — machine-facing SEO metadata, keep `toFixed` (add the eslint-disable if the guard trips it — it won't; it's `toFixed`, not `toLocale*`).
- Radius-picker labels (`PlaceSearch.tsx:44-47,222,225`, `community/feed/page.tsx:260-261`) — product-defined km parameters, not measurements; unit-converting a radius picker is a product decision, out of scope (note as follow-up).
- `lib/passes-summary.ts` `monthLabel`/`MONTH_NAMES` (month-number → name for a selector) and gamification challenge countdowns (`formatDaysRemaining`, `formatDaysShort`) — translated-copy territory (i18n catalogs), not Intl formatting.
- `lib/exploration.ts` `buildShareSummary` — test-only consumers; leave untouched.
- `TripCollaborateModal.tsx:1564` `<time dateTime={iso}>` — machine attribute, keep raw ISO.
- `TimeWindowPills.tsx` `windowStartISO` — query-param builder, not display.

**Per-task verification loop (identical for Tasks 2–7):**

1. Migrate the task's files per the recipe.
2. `cd apps/companion && pnpm test -- <touched test paths>` — update assertion literals to en/UTC/metric seam output where they break; never delete assertions.
3. `pnpm test && pnpm typecheck && pnpm lint` (full) — all green (lint: 0 errors; 4 pre-existing warnings ok).
4. `grep` proves the migrated pattern is gone from the task's files (each task lists the exact grep).
5. Commit.

---

### Task 1: Shared seam additions (`durationCompact` + `formatCount` locale param)

**Files:**

- Modify: `packages/shared/src/format.ts` (Formatters interface + implementation)
- Modify: `packages/shared/src/format.spec.ts`
- Modify: `packages/shared/src/rider-format.ts` (`formatCount`)
- Modify: `packages/shared/src/rider-format.spec.ts` (create if absent — check first)

**Interfaces:**

- Consumes: existing `createFormatters`.
- Produces: `Formatters.durationCompact(totalMinutes: number): string` ("52m" / "4h 12m" / "4h"); `formatCount(value: number, locale?: string): string` — locale omitted keeps today's runtime-default behavior (mobile untouched).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/format.spec.ts` inside the duration describe (or a new one):

```ts
describe("createFormatters — durationCompact", () => {
  const en = createFormatters({ locale: "en-US", units: "metric" });
  it("keeps the tight compact style used by ride tables", () => {
    expect(en.durationCompact(252)).toBe("4h 12m");
    expect(en.durationCompact(52)).toBe("52m");
    expect(en.durationCompact(120)).toBe("2h");
  });
});
```

For `formatCount`: check `ls packages/shared/src/rider-format.spec.ts`; if absent create it with the vitest header, else append:

```ts
import { describe, expect, it } from "vitest";
import { formatCount } from "./rider-format";

describe("formatCount", () => {
  it("localizes grouping when a locale is passed", () => {
    expect(formatCount(1234, "de-DE")).toBe("1.234");
  });
  it("keeps runtime-default behavior when locale is omitted (mobile contract)", () => {
    expect(formatCount(1234)).toBe((1234).toLocaleString());
  });
  it("keeps the compact k form", () => {
    expect(formatCount(12600, "en-US")).toBe("12.6k");
  });
});
```

(If `formatCount`'s current compact threshold/shape differs from `12.6k`, read `rider-format.ts` first and pin the test to its ACTUAL current output with the locale threaded — the contract is "same output, locale-aware grouping", not new behavior.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && pnpm test -- format && pnpm test -- rider-format`
Expected: FAIL — `durationCompact` not a function; `formatCount` rejects the second argument (or grouping assertion fails).

- [ ] **Step 3: Implement**

In `packages/shared/src/format.ts`, add to the `Formatters` interface after `duration`:

```ts
  /** "52m" / "4h 12m" — the tight table variant of `duration()`. */
  durationCompact(totalMinutes: number): string;
```

and to the returned object after `duration`:

```ts
    durationCompact: (totalMinutes) => {
      const total = Math.max(0, Math.round(totalMinutes));
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      if (hours === 0) return `${minutes}m`;
      if (minutes === 0) return `${hours}h`;
      return `${hours}h ${minutes}m`;
    },
```

In `packages/shared/src/rider-format.ts`, thread the locale through `formatCount`'s existing `toLocaleString()` calls: change the signature to `formatCount(value: number, locale?: string)` and every internal `.toLocaleString()` to `.toLocaleString(locale)` (an `undefined` locale is the runtime default — identical to today). Do not change thresholds or the k-suffix logic.

- [ ] **Step 4: Verify green + build**

Run: `cd packages/shared && pnpm test && pnpm build`
Expected: all shared specs pass; tsc clean.

- [ ] **Step 5: Typecheck consumers (mobile must be untouched by the optional param)**

Run: `(cd apps/mobile && pnpm typecheck) && (cd apps/companion && pnpm typecheck)`
Expected: both PASS with zero mobile changes.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/format.ts packages/shared/src/format.spec.ts packages/shared/src/rider-format.ts packages/shared/src/rider-format.spec.ts
git commit -m "feat(shared): add durationCompact formatter and locale-aware formatCount"
```

---

### Task 2: PR3 surface A — dashboard home, rides tables, KPI tiles, bikes, Sidebar

**Files (all [client] unless noted; line refs from the audit @ df9f0f2d):**

- Modify: `src/app/(dashboard)/page.tsx` (`:365` percent, `:388` toLocaleString, `formatShortDate` import, `formatSyncedLabel:337-351` relative buckets)
- Modify: `src/app/(dashboard)/_home/RecentRidesTable.tsx` (`formatShortDate:27,36`, `formatDurationCompact:56`)
- Modify: `src/app/(dashboard)/rides/_components/RidesTable.tsx` (`formatShortDate:44,57`, `formatKmValue`, `formatDurationCompact:81`)
- Modify: `src/app/(dashboard)/rides/_components/RideKpiCards.tsx` (`splitFormattedDistance`, `useNumberFormat` consumer)
- Modify: `src/app/(dashboard)/settings/bikes/page.tsx` (`:244,:293` toLocaleString)
- Modify: `src/components/Sidebar.tsx` (`:378` toLocaleString, `:379` toFixed, `:710` formatRelativeTime)
- Modify: `src/components/community/CommunityRideCard.tsx` + `src/components/community/SharedRidesSection.tsx` (`formatShortDate`, `formatKmValue`, `formatDuration`, `formatCount` — migrate now because they share the tables' helpers; they are [client])
- Tests: colocated `*.test.tsx` for any of the above (search per file: `ls <dir> | grep test`).

**Interfaces:**

- Consumes: recipe + Task 1's `durationCompact`; `formatCount(n, format.locale)`.
- Produces: these files import NOTHING from the `lib/utils.ts` format family afterwards.

- [ ] **Step 1: Migrate each file per the recipe** — `const format = useFormat();` + mappings. For `(dashboard)/page.tsx` `formatSyncedLabel`, keep the translated wrapper but replace the hand-rolled minute/hour/day buckets with the seam: `t("Mobile synced {when}", { when: format.relativeTime(iso) })` (adjust to the function's actual t() shape after reading it — the rule: buckets go, translation wrapper stays).
- [ ] **Step 2: Run the touched tests, fix literals**: `cd apps/companion && pnpm test -- RecentRidesTable RidesTable RideKpiCards Sidebar CommunityRideCard SharedRidesSection` (whichever exist) — update expected strings to en/UTC/metric seam output.
- [ ] **Step 3: Verify pattern removal**: `grep -n "formatShortDate\|formatKmValue\|formatDurationCompact\|splitFormattedDistance\|toLocaleString()" src/app/(dashboard)/page.tsx src/app/(dashboard)/_home/RecentRidesTable.tsx src/app/(dashboard)/rides/_components/RidesTable.tsx src/app/(dashboard)/rides/_components/RideKpiCards.tsx src/app/(dashboard)/settings/bikes/page.tsx src/components/Sidebar.tsx src/components/community/CommunityRideCard.tsx src/components/community/SharedRidesSection.tsx` → zero display hits (imports of still-shared helpers by OTHER files are fine — only these files must be clean).
- [ ] **Step 4: Full gate**: `pnpm test && pnpm typecheck && pnpm lint` — green.
- [ ] **Step 5: Commit**: `git add -A src/ && git commit -m "refactor(companion): route dashboard and ride tables through useFormat"`

---

### Task 3: PR3 surface B — ride detail/stats/compare/road-map + helper retirements (PR 3 wrap)

**Files:**

- Modify: `src/app/(dashboard)/rides/[rideId]/page.tsx` (`:231,:233` dates, `useNumberFormat`, `splitFormattedSpeed/Elevation`, local `splitDuration:787-790` → keep shape, call `format.durationCompact`)
- Modify: `src/app/(dashboard)/rides/stats/page.tsx` (`:564,:840,:945` toFixed, `:701` percent, `useNumberFormat`, `splitFormattedDistance`, heatmap `title` `cell.date` → `format.calendarDate`)
- Modify: `src/app/(dashboard)/rides/compare/page.tsx` (`formatShortDate:268,478,479,629,630`, `formatKmValue`, `formatDurationCompact:257,432,433`)
- Modify: `src/app/(dashboard)/rides/road-map/page.tsx` (`:966` toLocaleString, `formatDate:868,871`, `formatDistanceFromMeters`, `useNumberFormat`)
- Modify: `src/app/(dashboard)/rides/road-map/_components/RoadSegmentPopover.tsx` (`:107` toFixed, `formatShortDate`, `formatDistanceFromMeters`)
- Modify: `src/app/(dashboard)/settings/profile/page.tsx` (`:114` joined label → `format.monthYear(joinedAt)`)
- Modify: `src/lib/ride-detail.ts` (`formatNumber:76` → take `format: Formatters` param, `format.decimal(v, digits)`; callers pass their `format`)
- Modify: `src/lib/ride-compare.ts` (`formatDelta:318,321` → same injection; `:276,:333` excluded-technical stay)
- Modify: `src/lib/ride-stats.ts` (delete `MONTH_LABELS:13`; axis ticks at `:250,:251,:261` become caller-side `format.monthYear(dateStr)` — restructure so the lib returns the raw date string and `rides/stats/page.tsx` formats it, or inject `Formatters`; pick whichever keeps the lib pure with the SMALLER diff)
- Delete: `src/hooks/useNumberFormat.ts` + its test (all 5 consumers migrated by now: road-map, rideId, RideKpiCards, stats, CommunitySidebar — CommunitySidebar's `useNumberFormat` call migrates HERE even though its other formatting waits for Task 4: swap the hook call to `format.number`)
- Modify: `src/lib/utils.ts` — delete now-orphaned `formatSpeed`, `formatElevation` (dead exports per audit)
- Modify: `apps/companion/package.json` — remove `"date-fns"` (unused, audit §6) + `pnpm install` to update the lockfile
- Tests: colocated tests of all the above.

**Interfaces:**

- Consumes: recipe; Task 1.
- Produces: `useNumberFormat` no longer exists (grep-proof); `ride-detail.ts`/`ride-compare.ts` builders take `format: Formatters`.

- [ ] **Step 1: Migrate per recipe** (client files → `useFormat()`; libs → param injection with `import type { Formatters } from "@tarmoto/shared"`).
- [ ] **Step 2: Touched tests green with updated literals**: `pnpm test -- ride-detail ride-compare ride-stats rides` (narrow as needed).
- [ ] **Step 3: Removal proofs**:
  - `grep -rn "useNumberFormat" src/` → zero hits.
  - `grep -n "formatSpeed\|formatElevation" src/lib/utils.ts` → zero hits.
  - `grep -n "date-fns" package.json` → zero hits.
- [ ] **Step 4: Full gate** (`pnpm test && pnpm typecheck && pnpm lint`), plus `pnpm test:e2e -- format-prefs` (must still pass — no e2e literals touched yet).
- [ ] **Step 5: Commit (PR 3 boundary)**:

```bash
git add -A
git commit -m "refactor(companion): migrate ride surfaces to useFormat and retire useNumberFormat"
```

PR 3 title: `refactor(companion): locale-aware formatting for ride and dashboard surfaces`. Body: recipe link, behavior-change ledger (Global Constraints), exclusions cited.

---

### Task 4: PR4 surface A — achievements + gamification

**Files:**

- Modify: `src/app/(dashboard)/achievements/page.tsx` (12× toLocaleString `:539-1164`, en-GB dates `:662,:675` → `format.shortDate`/`format.monthYear` + keep `.toUpperCase()`, percents `:640,:740`)
- Modify: `src/lib/gamification.ts` (internal `formatNumber:288` used at `:246,:248` → inject `format: Formatters` into the exported builders that reach those lines; countdown copy `formatDaysRemaining` STAYS)
- Modify: `src/lib/gamification-fetch.ts` (adjust call-through signatures if the builders' params changed)
- Modify: `src/components/community/CommunitySidebar.tsx` (its remaining `toLocaleString`/gamification-label consumers; `useNumberFormat` swap already done in Task 3)
- Tests: colocated (`gamification*.test.ts`, achievements/CommunitySidebar tests).

**Interfaces:** consumes recipe; produces gamification builders that take `Formatters`.

- [ ] **Step 1: Migrate per recipe.**
- [ ] **Step 2: Touched tests green** (`pnpm test -- gamification achievements CommunitySidebar`).
- [ ] **Step 3: Removal proof**: `grep -n "toLocaleString\|'en-GB'" src/app/(dashboard)/achievements/page.tsx src/lib/gamification.ts src/components/community/CommunitySidebar.tsx` → zero display hits.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**: `refactor(companion): localize achievements and gamification labels`

---

### Task 5: PR4 surface B — community, collections, rider profile, trips, planner

**Files:**

- Modify: `src/app/(dashboard)/community/collections/page.tsx` (`formatRelativeTime:389,482`), `.../collections/[collectionId]/page.tsx` (`:369` relative, `:795-1120` ride dates), `.../collections/discover/[slug]/page.tsx` (`:186` relative, `:252` toLocaleString), `src/app/community/collections/shared/[slug]/page.tsx` **[rsc]** (`:140` relative, `:156` toLocaleString → `getServerFormatters`)
- Modify: `src/app/(dashboard)/community/[riderId]/page.tsx` (`splitFormattedDistance`, `formatCount` → pass `format.locale`), `src/lib/rider-profile.ts` (`formatCount` → accept + thread a `locale: string` param)
- Modify: `src/app/(dashboard)/trips/page.tsx` (`formatRelativeTime:1030` + `.toUpperCase()` stays), `trips/[tripId]/page.tsx` (`:867` toLocaleString, `:876` toFixed, `formatDistance`, `formatDuration:425,860`), `trips/planner/page.tsx` (`formatDistance`, `formatDuration:2573,3346`), `trips/join/[tripId]/[code]/page.tsx` (via `TripRouteOverview`)
- Modify: `src/components/trips/DayByDayList.tsx` (`formatDistance`, `formatDuration:126`), `src/components/TripRouteOverview.tsx` (`formatDistance`) — both [leaf] with all-client callers → `useFormat()`
- Modify: `src/components/TripImportDialog.tsx` (`:238` toFixed, `formatDistance`), `src/components/SegmentSidebar.tsx` (`formatDistance`), `src/components/TripStopsPanel.tsx` + `src/components/planner/PoiDetails.tsx` (`:194` toLocaleString), `src/components/planner/RoadPreviewPopover.tsx` (`:279,:327` toFixed), `src/components/planner/InspectTab.tsx` (`formatDuration:133,139`)
- Modify: `src/components/TripCollaborateModal.tsx` — DELETE the local `formatRelativeTime:1754-1761` and `formatActivityTime:1783-…`; render `entry.created_at` via `format.relativeTime(entry.created_at)` (keep the `<time dateTime>` raw-ISO attr at `:1564`)
- Modify: `src/app/(dashboard)/community/feed/page.tsx` — NOT the radius copy (excluded); only migrate any date/number display present.
- Tests: colocated (collections, trips, TripCollaborateModal, DayByDayList tests).

**Interfaces:** consumes recipe; produces: no file in this list imports `formatRelativeTime`/`formatDistance`/`formatDuration` from utils afterwards; `rider-profile.ts` takes a locale.

- [ ] **Step 1: Migrate per recipe** ([rsc] file uses `getServerFormatters()`).
- [ ] **Step 2: Touched tests green.**
- [ ] **Step 3: Removal proof**: `grep -rln "formatRelativeTime\|formatDistance\b\|formatDuration\b" src/app/(dashboard)/community src/app/(dashboard)/trips src/components/trips src/components/planner src/components/TripCollaborateModal.tsx src/components/TripImportDialog.tsx src/components/SegmentSidebar.tsx` → zero.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**: `refactor(companion): localize community, collections, and trip surfaces`

---

### Task 6: PR4 surface C — discover, roads, closures, passes, map popovers

**Files:**

- Modify: `src/app/discover/_components/ZoneDetailPanel.tsx` (`:82-:148` toFixed; `:131` coordinate label EXCLUDED), `ZoneListPanel.tsx` (`:90,:100` toFixed)
- Modify: `src/components/roads/SegmentDetailSidebar.tsx` (`:195` toFixed, `:222` percent, `:363` relative, `formatDistanceFromMeters`, `formatDate`), `roads/RideDetailSidebar.tsx` (`formatDate:179,182`, `formatDurationCompact:148`, splits), `roads/TripDetailSidebar.tsx` (`splitFormattedElevation`, `formatDuration/durationMin:153`)
- Modify: `src/components/RoadPreviewCard.tsx` (`:117,:145` toFixed, `:228,:252` relative), `src/components/RoadReviewsPanel.tsx` (`:467` toFixed, `:999` relative), `src/components/SegmentTrendChart.tsx` (`:80,:317` toFixed; ticks `:164` → `format.monthYear(p.date)`, tooltip `:184` → `format.calendarDate(p.date)`)
- Modify: `src/components/PassesPanel.tsx` (`:379,:443` toLocaleString → `format.elevation`), `src/components/ClosuresPanel.tsx` (`:214-218` previewDay → `format.calendarDate(previewDate)`; window renders at `:413,:497` via injected summary), `src/lib/closures-summary.ts` (`formatClosureWindow:123-134` → take `format: Formatters`, use `calendarDateRange`/`calendarDate` + keep "onward" copy)
- Modify: `src/components/map/MapPointPopover.tsx` (`:386` relative, `:442` closure window caller, `:455` toLocaleString)
- Modify: `src/app/explore/page.tsx` (its display toFixed sites if present per grep)
- Modify: `src/app/roads/best/[country]/[region]/_components/BestRoadsList.tsx` **[rsc]** (`:67` toFixed → `getServerFormatters`), `BestRoadsMap.tsx` [client], `src/lib/best-roads-format.ts` (`:7,:12` → inject `Formatters`), `src/lib/best-roads-embed.ts` (thread the param)
- Tests: colocated (closures-summary, best-roads-format, panels).

**Interfaces:** consumes recipe; produces `formatClosureWindow(closure, format)` and best-roads formatters taking `Formatters`.

- [ ] **Step 1: Migrate per recipe.**
- [ ] **Step 2: Touched tests green** (closures-summary tests will need en/UTC literals — the UTC pinning itself must NOT change: `calendarDate*` is UTC by construction; assert a day-shift case stays stable).
- [ ] **Step 3: Removal proof**: `grep -rn "'en-US'\|'en-GB'" src/components src/lib src/app/discover src/app/roads` → zero hits.
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**: `refactor(companion): localize discover, roads, and closure surfaces`

---

### Task 7: PR4 surface D — billing, embeds, shared/public pages

**Files:**

- Modify: `src/lib/subscription.ts` (`formatDate:362-371` internal → the exported builders that reach it (`describeRenewal:210-222`, `formatInvoiceDate:236`) take `format: Formatters` and use `format.date(iso)` — UTC pin removed, instants per audit)
- Modify: `src/app/(dashboard)/settings/subscription/page.tsx` (pass `useFormat()`'s object into the builders at `:110,:553`)
- Modify: `src/lib/ride-embed.ts` (`formatRideEmbedStat:48` → inject `Formatters`, `format.integer`)
- Modify: `src/app/embed/rides/_components/SharedRideEmbedWidget.tsx` [client] (`:75` relative, `:159` duration, `:166,:175` toFixed, ride-embed caller), `src/app/rides/shared/[token]/_components/RouteEmbedPanel.tsx` [client] (ride-embed caller)
- Modify: `src/app/rides/shared/[token]/page.tsx` **[rsc]** (`:77` relative, `:119,:127` toFixed, splitDuration local copy), `src/app/rides/road-map/shared/[token]/page.tsx` **[rsc]** (`:117,:248` toLocaleString, `:175` percent), `src/app/trips/shared/[token]/page.tsx` **[rsc]** (splits/duration via public-share)
- Modify: `src/components/public-share.tsx` **[leaf in rsc context]** — add `format: Formatters` PROP (cannot call the hook); both rsc callers pass `await getServerFormatters()`; its local `splitDuration:335-340` uses `format.durationCompact`
- Modify: `src/app/embed/roads/_components/BestRoadsEmbedWidget.tsx` **[rsc]** (`:188` toFixed + best-roads-format caller)
- Tests: colocated (subscription lib tests, embed widget tests).

**Interfaces:** consumes recipe + Task 6's `best-roads-format` signatures; produces zero hardcoded-locale formatting anywhere in `src/`.

- [ ] **Step 1: Migrate per recipe.**
- [ ] **Step 2: Touched tests green** (subscription tests: UTC-pinned expectations become viewer-tz/en defaults — in jsdom TZ=UTC they usually stay byte-identical; adjust only where they don't).
- [ ] **Step 3: Removal proof**: `grep -rn "toLocaleDateString\|toLocaleTimeString\|new Intl\." src/ --include="*.ts" --include="*.tsx" | grep -v "src/format/" | grep -v test` → zero hits; `grep -rn "toLocaleString" src/ | grep -v "src/format/" | grep -v test | grep -v resolvedOptions` → only `packages` externals (none in companion src).
- [ ] **Step 4: Full gate.**
- [ ] **Step 5: Commit**: `refactor(companion): localize billing, embed, and shared-page surfaces`

---

### Task 8: Cleanup, ESLint guard, e2e payoff proof (PR 4 wrap)

**Files:**

- Modify: `src/lib/utils.ts` — DELETE the entire format family: `formatDistance`, `formatDistanceFromMeters`, `splitFormattedDistance`, `splitFormattedSpeed`, `splitFormattedElevation`, `formatKmValue`, `formatDuration`, `formatDurationCompact`, `formatDate`, `formatShortDate`, `formatRelativeTime` (+ their now-unused imports/helpers). Anything else in utils.ts stays.
- Modify: `apps/companion/eslint.config.mjs` — add the guard block.
- Modify: `apps/companion/e2e/tests/format-prefs.spec.ts` — add the visible-output test.
- Tests: `src/lib/utils` tests (delete the format-family cases), any straggler updates.

- [ ] **Step 1: Delete the utils format family**, then prove nothing imports it:

Run: `grep -rn "formatDistance\|formatDistanceFromMeters\|splitFormatted\|formatKmValue\|formatDuration\|formatDate\|formatShortDate\|formatRelativeTime" src/ --include="*.ts" --include="*.tsx" | grep -v "src/format/" | grep "from \"@/lib/utils\"\|from '@/lib/utils'"`
Expected: zero hits. (If any remain, a prior task missed a file — migrate it per the recipe before proceeding.)

- [ ] **Step 2: Add the ESLint guard** to `apps/companion/eslint.config.mjs` (append to the exported config array, after the existing raw-fetch guard block, matching its style):

```js
  {
    // Locale-formatting guard: all display formatting goes through the
    // src/format seam (useFormat/getServerFormatters). Raw toLocale*/Intl
    // constructions bypass the rider's format preferences.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/format/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message:
            "Use useFormat()/getServerFormatters() (src/format) instead of toLocaleString — it applies the rider's format preferences.",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            "Use format.date()/shortDate()/calendarDate() from src/format instead of toLocaleDateString.",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleTimeString']",
          message: "Use format.time()/dateTime() from src/format.",
        },
        {
          selector: "NewExpression[callee.object.name='Intl']",
          message:
            "Construct Intl formatters only inside src/format (the seam memoizes and applies preferences). Timezone DETECTION via Intl.DateTimeFormat().resolvedOptions() without `new` remains allowed.",
        },
      ],
    },
  },
```

Run: `pnpm lint` — expected: 0 errors (the tz-detection call sites use no `new` and survive; if any straggler trips the rule, migrate it — do not add disables).

- [ ] **Step 3: Add the e2e payoff test** to `apps/companion/e2e/tests/format-prefs.spec.ts` (inside the existing `test.describe`, which already runs with `locale: "cs-CZ", timezoneId: "Europe/Prague"`):

```ts
test("renders localized numbers and dates for a cs-CZ rider", async ({
  authedPage: page,
  mockApi,
  user,
}) => {
  await mockApi.seedRide(user, {
    name: "Localized ride",
    distance_km: 1234.5,
    started_at: "2025-04-18T22:30:00Z",
  });

  await page.goto("/rides");
  await expect(page.getByText("Localized ride")).toBeVisible();

  // cs-CZ decimal comma + NBSP grouping ("1 234,5") — the visible payoff
  // of the whole migration.  /  cover ICU grouping variants.
  await expect(page.getByText(/1[  \s]234,5/).first()).toBeVisible();

  // 22:30Z on Apr 18 is Apr 19 in Prague — viewer-timezone day shift.
  await expect(
    page.getByText(/19\.\s*4\.|19\. 4\. 2025/).first(),
  ).toBeVisible();
});
```

(Adjust the ROUTE and locators to where the rides table actually renders distance/date — the test's assertions [comma-decimal grouping + Prague day shift] are the contract; the page/selector may be tuned to the real DOM. If the rides list truncates decimals, seed a value that survives, e.g. assert on the ride detail page instead.)

Run: `pnpm test:e2e -- format-prefs`
Expected: 3 passed.

- [ ] **Step 4: Full final gate:**

```bash
(cd packages/shared && pnpm test)
cd apps/companion && pnpm test && pnpm typecheck && pnpm lint
pnpm test:e2e
```

Expected: everything green (full e2e suite — other specs may assert date/number literals that this migration changed; fix THOSE expectations to the localized output, never revert the rendering).

- [ ] **Step 5: Commit (PR 4 boundary):**

```bash
git add -A
git commit -m "refactor(companion): delete legacy formatters and enforce the format seam"
```

PR 4 title: `refactor(companion): complete locale-formatting migration with lint guard`. Body: behavior-change ledger, exclusions list, e2e payoff evidence.

---

## Deferred / follow-ups (record in PR 4 body)

- Radius-picker unit awareness (`PlaceSearch`, feed copy) — product decision.
- `passes-summary.ts` month names + gamification countdown copy — i18n-catalog work, not Intl.
- Mobile migration to `createFormatters`; settings editor for format prefs (spec §8).
- `lib/exploration.ts` share summary — dead code candidate.
