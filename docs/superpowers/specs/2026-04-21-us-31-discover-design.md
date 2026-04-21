# US-31 — Full-screen Fun Zone discovery map

**Issue:** [#43](https://github.com/Studio81Labs/tarmoto/issues/43)
**Scope:** companion (web) + backend
**Status:** design proposed

## Goal

Give riders a dedicated `/discover` surface that renders the road-quality
heatmap with the analytical Fun Zone layer on top, so that pre-computed
"best riding regions" become browsable and shareable. Users can draw a
rectangular region of interest to filter the zones visible in a ranked
side list, and click into any zone to see its top contributing roads with
per-road elevation sparklines.

## Non-goals

- **Polygon draw tool.** Rectangle-only for MVP. Filed as a follow-up if
  real users tell us the bbox shape is too coarse.
- **Arbitrary "top roads in any drawn region"** — `/roads/best` (US-46)
  already ranks roads inside curated region bboxes. We do not expose an
  on-the-fly ranker over user-drawn shapes. The drawn rectangle filters
  **zones**, not roads.
- **Hazard overlay on /discover.** The discovery surface is about Fun Zone
  pre-computation; hazards are a secondary real-time signal better viewed
  on `/explore`. Follow-up if users want it merged.
- **Fun Zone re-calculation pipeline.** We consume whatever the analytics
  pipeline writes to `fun_zones` / `fun_zone_roads`. Building that
  pipeline is out of scope.
- **"Save zone to trip" / export / other trip-planner integrations.**
  These depend on the trip planner (US-32) landing first.
- **Authenticated-only gating.** The page is public. Discovery is a
  conversion surface; there's nothing here worth protecting.
- **Mobile-first layout pass.** A functional bottom-sheet + drawer
  fallback is in scope; a proper mobile design revisit is a follow-up.
- **Localization (i18n).** English-only, matching the rest of the
  companion.

## Acceptance criteria (from issue) → resolution

| #   | Criterion                                                   | How we meet it                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Full-screen MapLibre GL JS canvas with road quality heatmap | `/discover` mounts a new `MapCanvas` with the existing `tarmoto-roads` vector source + quality line layer                            |
| 2   | Draw polygon/rectangle region tool                          | Custom rectangle-draw control (rectangle-only; polygon filed as follow-up)                                                           |
| 3   | Fun Zone clusters highlighted with composite score          | Zone `boundary` polygons rendered as fill + outline layers, `fill-color` interpolated on `composite_score`; rank labels at centroids |
| 4   | Click zone to see top roads, curviness, elevation profile   | Right-side `ZoneDetailPanel` fed by new `GET /roads/fun-zones/:id`; per-road mini SVG sparklines                                     |
| 5   | Zoom/pan with smooth performance                            | Viewport-driven query debounced 300ms, rounded-bbox cache key, shared `MapCanvas` for layer consolidation                            |

## Architecture

### Route and chrome

New public route: **`/discover`**. Lives at the top level (not under
`/trips/*`) since it's a conversion surface for anonymous visitors.

- `apps/companion/src/app/discover/layout.tsx` — public-aware chrome
  mirroring `/explore` and `/roads/best` (public header for anon,
  `AppShell` for signed-in users).
- `apps/companion/src/app/discover/page.tsx` — orchestrates map + panels,
  owns URL state sync.
- `apps/companion/src/middleware.ts` — add `/discover` to `PUBLIC_PATHS`.

### Shared map primitive

Extract the base MapLibre setup from `QualityMap.tsx` into a reusable
component:

```
apps/companion/src/components/map/MapCanvas.tsx
```

**Responsibilities:**

- Mount MapLibre with `MAP_STYLE_URL`, standard navigation / geolocate /
  scale controls, `ResizeObserver` cleanup.
- Register the vector tile source (`tarmoto-roads`) and the `quality` +
  `surface` line layers with their existing paint/zoom interpolations.
- Expose `forwardRef` → `{ map: MapLibreMap | null }` so parents can add
  their own sources/layers after load.
- Fire `onReady(map)` once base layers finish loading.
- Fire `onViewChange({ lng, lat, zoom, bbox })` on debounced `moveend`.
- Accept optional `qualityOpacityExpression` / `surfaceOpacityExpression`
  so `/explore`'s existing filter-dim behavior survives the extraction.

**Props:**

```ts
interface MapCanvasProps {
  center: { lng: number; lat: number };
  zoom: number;
  showQuality: boolean;
  showSurface: boolean;
  qualityOpacityExpression?: ExpressionSpecification;
  surfaceOpacityExpression?: ExpressionSpecification;
  onViewChange?: (view: {
    lng: number;
    lat: number;
    zoom: number;
    bbox: [number, number, number, number];
  }) => void;
  onReady?: (map: MapLibreMap) => void;
  children?: React.ReactNode; // reserved for future layer composition
}
```

`/explore`'s `QualityMap.tsx` keeps its hazards logic inline (filter-driven
fetch is tightly coupled, not worth generalizing yet) but delegates map
init + quality/surface to `MapCanvas`. Net diff for `/explore`: an
internal refactor with no behavior change.

### Discover page components

```
apps/companion/src/app/discover/
  layout.tsx
  page.tsx
  _components/
    DiscoverMap.tsx         # MapCanvas + FunZoneLayer + RegionDrawControl
    FunZoneLayer.tsx        # imperative MapLibre source/layer management for zones
    RegionDrawControl.tsx   # rectangle-draw tool (custom, no external dep)
    ZoneListPanel.tsx       # left sidebar, ranked zones in effective bbox
    ZoneDetailPanel.tsx     # right sidebar, top roads + sparklines
    useDiscoverStore.ts     # Zustand slice for viewport / drawnBbox / selection

apps/companion/src/components/map/
  MapCanvas.tsx             # extracted from QualityMap (see above)
  ElevationSparkline.tsx    # pure SVG, reused by ZoneDetailPanel

apps/companion/src/lib/
  discover.ts               # typed fetchers for zones + zone detail
```

### Layout

Desktop (≥1280px): three columns — `ZoneListPanel` (300px left),
`DiscoverMap` (fill), `ZoneDetailPanel` (360px right, slides in when a
zone is selected).

Tablet (900–1279px): right panel becomes a bottom sheet.
Phone (<900px): left list collapses to a toggleable drawer; detail panel
is a bottom sheet.

Both sidebars reuse the existing `animate-slide-in-right` utility for
motion consistency with `/explore`.

### Fun Zone rendering (`FunZoneLayer`)

Four MapLibre layers registered on `MapCanvas.onReady`:

- `fun-zones-source` — GeoJSON source for zone boundary polygons, refreshed
  whenever `useZonesQuery` returns new data.
- `fun-zones-fill` — polygon fill, `fill-opacity: 0.25`, `fill-color`
  interpolated on `composite_score`:
  ```ts
  [
    "interpolate",
    ["linear"],
    ["get", "composite_score"],
    0,
    "#1e293b", // slate-800 (low)
    5,
    "#0ED3CF", // tarmoto-cyan (high)
  ];
  ```
- `fun-zones-line` — polygon outline, 1.5px, same color ramp, 0.8 opacity.
- `fun-zones-selected-line` — 3px cyan outline filtered to
  `selectedZoneId`.
- `fun-zones-label` — symbol layer at each polygon centroid with
  `text-field = ["get", "rank"]` (1-based rank in current effective
  bbox), white text on a dark halo.

Mouse behavior:

- `mouseenter` on fill layer → pointer cursor; emit `onHoverZone(id)` so
  the list can echo the highlight.
- `click` on fill layer → `setSelectedZoneId(id)`.
- Click on empty map → `setSelectedZoneId(null)`.

Selecting a zone triggers `map.fitBounds(boundary, { padding: 60 })` via
`easeTo` so the user sees the camera motion.

### Rectangle-draw tool (`RegionDrawControl`)

A thin imperative module, mounted on `MapCanvas.onReady`. Chosen over
`mapbox-gl-draw` because we need one shape (rectangle), and
MapLibre-compatibility of that lib requires ongoing fork vetting.
Approximately 80–120 lines of imperative code.

**UI:**

- Button overlay (top-left, below MapLibre's native controls): "Draw
  region" / "Cancel drawing" / "Clear region" (state-dependent label).
- When drawing, map cursor becomes crosshair; MapLibre's drag-pan is
  temporarily disabled.

**Interaction:**

- `mousedown` → record start `lng/lat`.
- `mousemove` → update `region-preview-source` with the live rectangle.
- `mouseup` → commit bbox, re-enable drag-pan, call
  `onRegionDrawn([w,s,e,n])`.
- Any drag with `|east-west| < 0.0001` or `|north-south| < 0.0001` is
  treated as a cancel (accidental click).

**Persistence sources/layers (separate from Fun Zone layers):**

- `region-preview-source` + matching fill/line layers (live during drag).
- `region-drawn-source` + matching fill/line layers (persistent after
  commit). Visually distinct styling (dashed outline, low-opacity fill).

Clear button removes `region-drawn-source` data and calls
`clearDrawnBbox()`.

### Backend: `GET /roads/fun-zones/:id`

New endpoint on the existing `roads` module. Public, default throttle.

**Query path** (`RoadsService.findZoneById(zoneId, limit = 10)`), two
queries in parallel:

```sql
-- 1. Zone itself
SELECT
  fz.id, fz.name, fz.composite_score, fz.road_count,
  fz.total_curve_km, fz.avg_quality, fz.best_season,
  ST_AsGeoJSON(fz.boundary)::json AS geojson
FROM fun_zones fz
WHERE fz.id = $1;

-- 2. Top-N contributing roads
SELECT
  rs.id, rs.road_name, rs.road_number,
  rs.quality_score, rs.curviness_score, rs.surface_type,
  rs.length_m, rs.confidence,
  rs.elevation_min, rs.elevation_max, rs.elevation_profile,
  ST_AsGeoJSON(rs.geom)::json AS geojson,
  fzr.contribution_score
FROM fun_zone_roads fzr
INNER JOIN road_segments rs ON rs.id = fzr.road_segment_id
WHERE fzr.fun_zone_id = $1
ORDER BY fzr.contribution_score DESC NULLS LAST,
         rs.quality_score DESC NULLS LAST
LIMIT $2;
```

Zone lookup returning 0 rows → `NotFoundException`.
Zero `fun_zone_roads` rows → return `top_roads: []` (not an error).

**Response DTO** (`apps/backend/src/modules/roads/dto/fun-zone-detail.dto.ts`):

```ts
export class FunZoneDetailDto {
  zone: {
    id: string;
    name: string | null;
    composite_score: number;
    road_count: number;
    total_curve_km: number | null;
    avg_quality: number | null;
    best_season: string | null;
    boundary: { lat: number; lng: number }[];
  };
  top_roads: FunZoneRoadDto[];
}

export class FunZoneRoadDto {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
  elevation_min: number | null;
  elevation_max: number | null;
  elevation_profile: number[] | null; // length-validated via normalizeElevationProfile
  geometry: { lat: number; lng: number }[];
  contribution_score: number | null;
}
```

Elevation profile uses the existing `normalizeElevationProfile` helper at
`apps/backend/src/modules/roads/roads.service.ts:382` so stale profiles
collapse to `null` rather than producing misaligned sparklines.

**Public access:** The backend currently runs with only a global
`ThrottlerGuard` (`apps/backend/src/app.module.ts`) — no `AuthGuard`
gates the `roads` module. `GET /roads/fun-zones` and the new
`GET /roads/fun-zones/:id` are already reachable by anonymous requests.
No backend guard changes required for US-31; if auth is later added
globally, these routes will need a `@Public()` marker, but that's a
concern for the issue that introduces the guard, not this one.

**OpenAPI:** regenerate `packages/openapi/types.ts` via
`pnpm build:shared && pnpm --filter @tarmoto/openapi generate` so the
companion's typed `openapi.paths` include the new endpoint.

### Data fetching (companion)

The companion does **not** use TanStack Query; `/explore` fetches
hazards via plain `fetch` through the typed `hazardsApi` wrapper in
`apps/companion/src/lib/api.ts` with manual debounce + `AbortController`
inside a `useEffect`. US-31 follows the same pattern for consistency.

- New typed wrapper `discoverApi` in `apps/companion/src/lib/api.ts`
  (or `apps/companion/src/lib/discover.ts` if the file becomes large):
  - `listZones({ bbox }, { signal })` → typed from
    `openapi.paths["/api/v1/roads/fun-zones"]["get"]`
  - `getZone(id, { signal })` → typed from
    `openapi.paths["/api/v1/roads/fun-zones/{id}"]["get"]`
- Inside `DiscoverMap.tsx` (or a small `useDiscoverZones` hook), the
  viewport/drawn-bbox driver effect:
  - Debounces 300ms on settle (mirrors `HAZARD_FETCH_DEBOUNCE_MS` at
    `QualityMap.tsx:45`).
  - Uses `AbortController` so a stale request can't overwrite fresh
    data (same `cancelled` flag pattern as hazards).
  - Rounds the bbox to 5 decimals in the cache key (plain Map in a ref)
    so mouse-jitter pans return the last result instead of refetching.
- Inside `ZoneDetailPanel.tsx`, a similar `useEffect` driven by
  `selectedZoneId` fetches the zone detail with `AbortController`. No
  long-lived cache — the endpoint is cheap enough to refetch on
  re-selection.

`effectiveBbox = drawnBbox ?? viewportBbox`. When the user draws a region
the viewport stops driving zone queries; when they clear it, the
viewport takes over again.

### State: `useDiscoverStore` (Zustand)

Parallels `useMapStore` (used by `/explore`) for consistency:

```ts
interface DiscoverState {
  center: { lng: number; lat: number };
  zoom: number;
  drawnBbox: [number, number, number, number] | null;
  selectedZoneId: string | null;
  hoveredZoneId: string | null;
  showQuality: boolean; // default true
  // setters
  setCenter;
  setZoom;
  setDrawnBbox;
  clearDrawnBbox;
  setSelectedZoneId;
  setHoveredZoneId;
  toggleQuality;
}
```

Unlike `/explore`, `/discover` does **not** persist to `localStorage`.
The URL is the shareable state; nothing else is worth preserving.

### URL sync

Query parameters:

- `lng,lat,z` — viewport (written only after user interaction, so the
  initial SEO-facing URL stays clean).
- `bbox` — drawn region as `w,s,e,n` (four comma-separated numbers).
- `zone` — selected zone id (UUID).

Two `useEffect`s in `page.tsx`:

1. Hydrate store from `searchParams` on mount (and on back/forward
   navigation).
2. `router.replace()` the URL when store changes. Use the same
   `hydrated` state flag as `/explore` page
   (`apps/companion/src/app/explore/page.tsx:90`) to prevent overwriting
   URL with defaults on the first render.

### Zone list panel (`ZoneListPanel`)

- **Header**: count ("12 Fun Zones in this area") + filter-source chip
  ("Viewport" / "Drawn region") — the chip is only visible when
  `drawnBbox != null`.
- **Rows** (ranked 1–N by `composite_score`, descending):
  - Rank badge (1, 2, 3, …) + zone name
    - Fallback when `name` is null: "Zone near {lat.toFixed(2)},{lng.toFixed(2)}"
  - Composite score pill (color matches polygon fill on map)
  - Secondary line: `{road_count} roads · {total_curve_km?.toFixed(0)} km curves · avg {avg_quality.toFixed(1)}★`
  - `best_season` appended when present
- **Active row** (matches `selectedZoneId`): cyan left border + darkened
  background.
- **Hover** → `setHoveredZoneId(id)` → map spotlights the polygon
  (outline thickens, 200ms transition via paint-prop update).
- **States**:
  - Empty (no drawn region): "No Fun Zones in view yet — zoom out or
    drag the map"
  - Empty (drawn region): "No Fun Zones in drawn region — try a larger
    area or clear"
  - Loading: 3 skeleton rows
  - Error: "Couldn't load zones — retry" button

### Zone detail panel (`ZoneDetailPanel`)

Driven by `useZoneDetailQuery(selectedZoneId)`. Slides in from the right
when a zone is selected.

**Contents:**

1. **Header** — zone name (or fallback), composite score (large,
   prominent), `best_season`, close `×` button.
2. **Stat strip** — `road_count`, `total_curve_km`, `avg_quality`;
   tabular-nums, small labels.
3. **Top roads list** (scrollable, one card per road, ordered by
   `contribution_score DESC`):
   - Road name + number (e.g. "D56 — Malá Bystřice")
   - Quality tier pill (reuses `QUALITY_CONFIG` from `@/lib/utils`)
   - Curviness score, length (km), surface type
   - **Mini elevation sparkline** — `<ElevationSparkline>`, 60px tall ×
     card-width, rendered from `elevation_profile` when non-null. Falls
     back to a subtle "no elevation data" note.
   - Clicking a road card emits `onSelectRoad(road)` → map highlights the
     road polyline with a 600ms pulse (outline + width bump). No
     navigation.

### `ElevationSparkline` (new helper)

`apps/companion/src/components/map/ElevationSparkline.tsx`.

Pure SVG, no chart dep:

- Input: `profile: number[]`, `width: number`, `height: number`,
  `stroke: string` (defaults to tarmoto-cyan).
- Output: a `<path>` built from a linear x-scale (index → px) and linear
  y-scale (min→height, max→0), plus min/max labels at the right edge.
- Gracefully renders nothing when `profile.length < 2`.

Avoids pulling Recharts/visx for a one-off visual. Two unit tests cover
the `d` string for a known input.

## Error handling

| Scenario                                    | Behavior                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /roads/fun-zones?bbox=…` fails         | List shows "Couldn't load zones — retry". Map keeps previous zones (no flicker to empty).                     |
| `GET /roads/fun-zones?bbox=…` returns empty | List shows context-aware empty state. Map source cleared.                                                     |
| `GET /roads/fun-zones/:id` 404              | Panel shows "Zone no longer available." `selectedZoneId` cleared from URL and store.                          |
| `GET /roads/fun-zones/:id` network error    | Panel shows "Couldn't load zone details — retry".                                                             |
| Invalid drawn rectangle (near-zero area)    | Draw control treats it as a cancel; `drawnBbox` stays at its previous value.                                  |
| `fitBounds` throws on malformed boundary    | Fall back to centroid centering; `console.warn` (matches hazards-fetch warning tone at `QualityMap.tsx:526`). |
| Endpoint not yet deployed                   | `useZonesQuery` 404 at endpoint level → treated as empty result.                                              |

## Edge cases

1. **Fun Zone table empty.** `/discover` must still render. Full-canvas
   "No Fun Zones available yet — check back soon." message with a link
   to `/explore`.
2. **Huge drawn bbox.** No area cap for MVP; the `idx_fun_zones_boundary`
   spatial index should scale. Revisit if production query times grow.
3. **Stale `zone=<uuid>` in URL.** If the referenced zone isn't in the
   current list (outside viewport/drawn bbox), still call
   `/roads/fun-zones/:id`, render the detail panel, and `fitBounds` to
   the zone's boundary so the user sees it. 404 → clear URL.
4. **Public page + anonymous load.** Since `/discover` is public, we may
   see anon users with very wide viewports. Spatial index handles it,
   but we'll monitor after first deploy. No MVP rate-limit beyond the
   default throttler.
5. **Deselecting.** Clicking the selected zone a second time, clicking
   empty map, clicking the `×` button, or pressing `Esc` all clear
   `selectedZoneId` and close the detail panel.

## Testing strategy

**Backend:**

- `apps/backend/src/modules/roads/roads.service.spec.ts` — extend with
  `findZoneById` cases:
  - Happy path (zone + ranked roads, confirm ordering by
    `contribution_score DESC NULLS LAST`)
  - Unknown zone id → `NotFoundException`
  - Zone with zero `fun_zone_roads` rows → returns `top_roads: []`
  - Elevation profile length mismatch → `null` (via existing helper)
- Existing `findFunZones` coverage is sufficient; no change needed.

**Companion:**

- No broad companion test harness (US-46/US-47 precedent). Verification
  via `pnpm lint`, `pnpm build:companion`, and manual browse-through.
- Narrow exception: `ElevationSparkline` has a pure `buildSparklinePath`
  helper (signature: `(profile: number[], width: number, height: number)
→ { d: string; min: number; max: number }`) that lives in
  `apps/companion/src/lib/elevation-sparkline.ts` so it fits the
  existing `src/lib/__tests__/*.test.ts` convention. Two Vitest tests
  under `apps/companion/src/lib/__tests__/elevation-sparkline.test.ts`:
  (1) assert the `d` string and min/max for a known input; (2) short
  arrays (< 2 points) return an empty `d`. The React component is a
  thin wrapper that renders `d` inside `<svg>`.

## SEO and chrome

- `/discover` is public but **not** a primary SEO target (dynamic,
  viewport-dependent content; `/roads/best/*` is where SEO lives).
- Static metadata on the layout: title/description (e.g. "Discover the
  best motorcycling regions — Tarmoto"), `robots: "index, follow"`, no
  canonical on query params.
- `apps/companion/src/app/sitemap.ts`: add a single `/discover` entry
  alongside `/explore` (`changeFrequency: "weekly"`, `priority: 0.7`).
- `apps/companion/src/app/robots.ts`: covered by the default allow
  policy; no change required unless a `disallow: "/discover"` is
  mistakenly present (verify during implementation).
- `apps/companion/src/middleware.ts`: add `/discover` to `PUBLIC_PATHS`
  so anon requests are not redirected to `/login`.

## Verification commands

```bash
pnpm lint
pnpm build:shared && pnpm --filter @tarmoto/openapi generate
pnpm build:backend && pnpm --filter @tarmoto/backend test
pnpm build:companion
pnpm --filter @tarmoto/companion test  # for buildSparklinePath
```

Manual:

1. `pnpm db:up && pnpm db:migrate` (seeded Fun Zones required; without
   them the empty state renders and nothing regresses).
2. `pnpm dev:backend` and
   `curl 'http://localhost:3000/api/v1/roads/fun-zones?bbox=18.0,49.3,18.7,49.8'`
   and `curl 'http://localhost:3000/api/v1/roads/fun-zones/<uuid>'`.
3. `pnpm dev:companion` — browse to `/discover`:
   - Confirm quality overlay + zone polygons render.
   - Draw a rectangle; confirm list filters to that region.
   - Click a zone polygon; confirm detail panel opens with top roads +
     sparklines.
   - Reload the page with `?zone=<uuid>`; confirm state rehydrates and
     map fits to the zone's bounds.
4. Regression: browse to `/explore` and confirm no behavior change
   (quality, surface, hazards, filters, URL state all still work) after
   the `MapCanvas` extraction.

## Follow-ups filed separately

1. **Polygon draw tool** if rectangle is too coarse.
2. **Hazard overlay on /discover** if users want hazards visible while
   planning.
3. **"Save zone to trip"** once US-32 (drag-and-drop route builder)
   ships.
4. **Fun Zone re-calculation pipeline** (analytics / ETL).
5. **Hover-preview of a zone's contributing polylines on the map** — UX
   polish, skipped for MVP.
6. **Mobile-first design pass** to replace the functional-but-basic
   bottom-sheet/drawer fallback.
7. **Analytics** on zone click-through to measure discovery funnel.

## Touched files (summary)

**New:**

- `apps/companion/src/app/discover/layout.tsx`
- `apps/companion/src/app/discover/page.tsx`
- `apps/companion/src/app/discover/_components/DiscoverMap.tsx`
- `apps/companion/src/app/discover/_components/FunZoneLayer.tsx`
- `apps/companion/src/app/discover/_components/RegionDrawControl.tsx`
- `apps/companion/src/app/discover/_components/ZoneListPanel.tsx`
- `apps/companion/src/app/discover/_components/ZoneDetailPanel.tsx`
- `apps/companion/src/app/discover/_components/useDiscoverStore.ts`
- `apps/companion/src/components/map/MapCanvas.tsx`
- `apps/companion/src/components/map/ElevationSparkline.tsx`
- `apps/companion/src/lib/elevation-sparkline.ts`
- `apps/companion/src/lib/__tests__/elevation-sparkline.test.ts`
- `apps/companion/src/lib/discover.ts` _(optional, split from api.ts if it grows)_
- `apps/backend/src/modules/roads/dto/fun-zone-detail.dto.ts`

**Modified:**

- `apps/companion/src/app/explore/_components/QualityMap.tsx` — delegate
  map init + base layers to `MapCanvas`; keep hazards logic inline.
- `apps/companion/src/middleware.ts` — add `/discover` to `PUBLIC_PATHS`.
- `apps/companion/src/app/sitemap.ts` — include `/discover`.
- `apps/backend/src/modules/roads/roads.controller.ts` — new
  `GET /roads/fun-zones/:id`.
- `apps/backend/src/modules/roads/roads.service.ts` — `findZoneById`.
- `apps/backend/src/modules/roads/roads.service.spec.ts` — test cases.
- `packages/openapi/openapi.yaml` _(generated)_ — new endpoint + DTOs.
- `packages/openapi/types.ts` _(generated)_.
