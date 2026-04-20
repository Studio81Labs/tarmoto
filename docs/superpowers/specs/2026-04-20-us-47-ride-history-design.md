# US-47 — Ride history with map and list view

**Issue:** [#59](https://github.com/Studio81Labs/tarmoto/issues/59)
**Scope:** companion (web) + backend
**Status:** design approved

## Goal

Replace the bare rides list page in the companion with a split-view ride history: a MapLibre map showing all filtered ride tracks alongside a sortable, filterable, paginated table. Users can filter by date range, distance, road quality, and ride type; search by ride name; rename rides; and navigate between map and table via reciprocal selection.

## Non-goals

- **Location-based search** ("passes near <place>") — requires a geocoding pipeline and is carved off as a separate follow-up issue.
- **Ride comparison flows** — `/rides/compare` already exists and is untouched.
- **Bulk export UI changes** — `BulkExportMenu` from the current page is preserved as-is.
- **Web companion component test infrastructure** — no Vitest/Testing Library setup exists today; adding it is out of scope.

## Acceptance criteria (from issue)

1. Map view: all ride tracks overlaid, click to select
2. List view: sortable table with date, distance, duration, avg quality
3. Filter by date range, distance, road quality
4. Search by ride name _(location search deferred — see non-goals)_
5. Pagination for large ride libraries

## Architecture

### Route and page structure

Replace the list-only page at [rides/page.tsx](<../../apps/companion/src/app/(dashboard)/rides/page.tsx>) with a split layout. New files under the route folder:

```
apps/companion/src/app/(dashboard)/rides/page.tsx        # shell: filters + split layout + url sync
apps/companion/src/app/(dashboard)/rides/_components/
  RidesFilters.tsx       # date range, distance, quality, search, type
  RidesMap.tsx           # MapLibre — renders all tracks for current filters
  RidesTable.tsx         # sortable table + pagination
  RideRow.tsx            # table row with selection/hover state
  useRidesQuery.ts       # url → list + tracks queries; selection state
```

**Desktop (≥ md):** 2-column split — map on left (~60% width, sticky), table on right. Filters bar spans the top.
**Mobile (< md):** filters bar on top, tab toggle (Map | List) below; one view at a time.

URL is the source of truth for filters, sort, and page so views are bookmarkable:

```
/rides?from=2026-01-01&to=2026-04-20&minDist=50&minQuality=3&q=sunday&sort=distance:desc&page=2
```

Selection (`selectedRideId`) stays in local component state — not URL — since it's an ephemeral interaction.

### Data flow

`useRidesQuery.ts` parses URL search params and exposes two independent fetches (plain `useEffect` + `AbortController`, matching the existing companion pattern):

1. **list query** → `GET /api/v1/rides` with filters + sort + pagination → `{ rides, total }`. Refires on any filter/sort/page change.
2. **tracks query** → `GET /api/v1/rides/tracks` with filters only (no pagination/sort) → `{ tracks, truncated }`. Debounced 250 ms on filter changes; unaffected by sort/page.

Filter inputs in `RidesFilters.tsx` are debounced (300 ms for text, immediate for selectors) before writing to the URL to avoid thrashing.

### Backend changes

#### 1. Ride `name` column

Migration adds a nullable `name varchar(120)` column to `rides`. Populated via rename UI; otherwise null. Exposed on `RideSummaryDto` and `RideDetailDto`; UI falls back to `Ride on <date>` when null.

`PATCH /api/v1/rides/:id` accepts `{ name?: string | null }`. Validation: trimmed, ≤120 chars; empty string coerces to null.

#### 2. Extended `ListRidesDto`

Adds optional params alongside the existing `limit`, `offset`, `type`:

```ts
started_from?:  string   // ISO date
started_to?:    string   // ISO date (inclusive end-of-day)
min_distance_km?: number
max_distance_km?: number
min_quality?:   number   // 1..5
max_quality?:   number   // 1..5
q?:             string   // ILIKE '%q%' against ride.name
sort?:  'started_at' | 'distance_km' | 'duration_min' | 'avg_road_quality'
order?: 'asc' | 'desc'   // default 'desc'
```

`RidesService.list()` extends the existing `createQueryBuilder` with an `andWhere` per provided filter and an `orderBy` derived from `sort`/`order` (default `started_at DESC`, matching current behavior). Existing `idx_rides_started` index covers the default sort. No new indexes for v1 — revisit if query plans warrant it.

#### 3. New endpoint — `GET /api/v1/rides/tracks`

Accepts the same filter params as `list` (ignores `limit`/`offset`/`sort`/`order`). Returns:

```ts
{
  tracks: Array<{ id: string; geometry: GeoJSON.LineString | null }>;
  truncated: boolean;
}
```

- Geometry comes from `ST_AsGeoJSON(ST_SimplifyPreserveTopology(route_geom, 0.0005))` — roughly 50 m tolerance at mid latitudes, small enough for overview rendering without visible degradation.
- Hard-caps at 500 rides per request (ordered by `started_at DESC`). If the filtered set exceeds 500, returns the most recent 500 with `truncated: true`; UI surfaces a "showing most recent 500 — refine filters" hint.
- Rides with `route_geom IS NULL` are excluded from the response.

### Frontend interaction details

**Map (`RidesMap.tsx`):**

- Single MapLibre GeoJSON source built from the `tracks` array.
- One `line` layer with data-driven styling via `feature-state`:
  - unselected: 2 px slate (`#64748b`), opacity 0.6
  - hovered: 3 px cyan, opacity 0.9
  - selected: 4 px cyan, opacity 1.0
- `feature-state` updates avoid re-rendering the whole source on selection change.
- Initial fit-bounds on first load of a result set; subsequent filter changes do **not** re-fit (preserves user's manual pan/zoom).
- Click handler on the line layer sets `selectedRideId`.

**Table (`RidesTable.tsx`):**

- Columns: Name · Date · Distance (km) · Duration (min) · Avg quality · (actions).
- Header click toggles sort for that column (server-driven, via URL update).
- Avg quality rendered as a colored chip using the existing `QualityTier` green→red ramp.
- Inline rename: click the name → editable input → blur/Enter calls `PATCH /rides/:id`, optimistically updates the row.
- Selected row highlights with a cyan left border; row scrolls into view when selection comes from the map.

**Filters (`RidesFilters.tsx`):**

- Date range: two native `<input type="date">`.
- Distance: dual-range slider (km), 0–500 default extent.
- Quality: 1–5 dot/chip selector (min / max).
- Search: text box, debounced 300 ms, matches ride name.
- Type: pill row (`free`, `commute`, `trip`, `tracked`, `all`).
- Reset button clears every filter and returns the URL to `/rides`.

**Selection sync:**

- Row click → update `selectedRideId` → map flies to that track's bounds.
- Map track click → update `selectedRideId` → table scrolls matching row into view.
- Row hover → map pulses that track (no pan).

**Pagination:**

- Existing backend offset/limit; fixed 20/page for v1.
- Prev/Next buttons plus "Page N of M" derived from `total`.
- No page-size selector for v1.

**States:**

- Loading: keep existing list skeleton shimmer; map shows centered spinner on first load, silently refetches after.
- Empty filtered: "No rides match these filters" + Reset button.
- Error: inline toast/banner; preserve last good state.

## Testing

- **Backend unit** — extend `rides.service.spec.ts` with filter/sort permutations (date bounds, distance bounds, quality bounds, `q` ILIKE, all sort columns both directions).
- **Backend e2e** — new spec for `GET /rides/tracks` covering filter parity with `list`, the 500-row cap with `truncated: true`, and exclusion of rides with null geometry.
- **Migration** — ensure `name` column migration runs clean up and down; verify existing rides read back with `name: null`.
- **Frontend** — no component test infra in companion today; rely on manual verification for this issue. If unit coverage becomes a priority, file a separate chore to set up Vitest + Testing Library.
- **Manual verification script** (for PR test plan): seed ≥20 rides across varied dates/distances/qualities; walk each AC — map + list sync in both directions, each filter in isolation and combined, search, sort on each column, pagination forward and back, rename happy-path + empty string, mobile tab toggle.

## Follow-ups

- **Location-based search (US-47 addendum)** — geocoded "passes near <place>" search using `ST_DWithin` on `route_geom`. Needs a geocoding provider decision and is its own deliverable. File before closing US-47.
- **Page-size selector** — if users ask for it once in the wild.
- **Companion component test infra** — separate chore; unblocks test coverage for this page and all future ones.
