# US-46 — Auto-generated "Best Roads" SEO pages

**Issue:** [#58](https://github.com/Studio81Labs/tarmoto/issues/58)
**Scope:** companion (web) + backend + shared
**Status:** design proposed

## Goal

Give the Tarmoto web companion a set of public, server-rendered "Best Roads in
&lt;region&gt;" pages that turn the community's road-quality data into
search-engine-discoverable content. Each page ranks the highest-scoring road
segments inside a curated region, embeds them on a map with Schema.org markup,
and links visitors into the product (auth flow / future trip planner).

## Non-goals

- **Photos.** The acceptance criterion lists "photos" but no photo pipeline
  exists yet (road reviews carry photo arrays but aren't user-facing on the
  web). Page design leaves a photo slot for future fill; filed as follow-up.
- **Trip planner CTA destination.** The "Plan a trip with these roads" CTA
  links to `/trip-planner?segments=…` which is not yet implemented
  (WEB-EPIC 1). The CTA is rendered as an `<a>` to that URL so SEO/UX is
  future-ready; we do not build the trip planner endpoint.
- **Weekly backend refresh cron.** Rankings stay fresh via Next.js
  Incremental Static Regeneration (`revalidate: 604800`, ~7 days) —
  no separate cron job or materialized view.
- **Region admin UI / CMS.** Region catalog is a hand-curated TypeScript file,
  not a DB table. Adding/editing regions is a code change.
- **Geocoding / free-form region search.** Out of scope (covered by #177).
- **Fun zones as regions.** `FunZone` is a derived analytical polygon, not an
  administrative region. We do not repurpose it here.
- **Localization (i18n).** Pages are English-only for now, matching the rest
  of the companion.

## Acceptance criteria (from issue) → resolution

| #   | Criterion                                           | How we meet it                                                               |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | SSR pages (Next.js)                                 | App Router segments rendered on the server with `generateStaticParams` + ISR |
| 2   | Auto-generated from top-scoring segments per region | Backend `GET /roads/best` ranks via composite score                          |
| 3   | Schema.org markup for rich results                  | `ItemList` of `TouristAttraction` in JSON-LD                                 |
| 4   | Map, ranked list, quality, curviness, photos        | Map + list + badges rendered; photos slot left stubbed                       |
| 5   | Region hierarchy country → region → sub-region      | Three-level URL tree; parent-child links in catalog                          |
| 6   | Updated weekly from latest community data           | ISR `revalidate: 604800` (7 days)                                            |
| 7   | CTA "Plan a trip with these roads" → trip planner   | Link to `/trip-planner?segments=…` (destination stubbed)                     |

## Architecture

### URL and route structure

```
/roads/best                              → index: all countries (hub page)
/roads/best/[country]                    → country page: lists regions in country
/roads/best/[country]/[region]           → region page: top roads in region
/roads/best/[country]/[region]/[subregion] → (optional) sub-region page
```

Slugs are lowercase kebab-case ASCII (`beskydy`, `tyrol`, `alpine-passes`).
Country slug is ISO 3166-1 alpha-2 lowercased (`cz`, `at`, `it`).

All four routes are public: add `/roads` (or just `/roads/best`) to
`middleware.ts` `PUBLIC_PATHS` so crawlers and anonymous visitors are not
redirected to `/login`. Reuse the `ExploreLayout` pattern (public header for
anon, `AppShell` for signed-in users) via a new `app/roads/best/layout.tsx`.

### Region catalog (shared package)

New file: `packages/shared/src/regions.ts`. A typed, hand-curated catalog —
no DB entity, no migration.

```ts
export interface Region {
  slug: string;                  // 'beskydy'
  country: string;               // 'cz' (ISO-3166-1 alpha-2, lowercased)
  name: string;                  // 'Beskydy'
  parent?: string;               // parent region slug (for sub-regions)
  bbox: [number, number, number, number]; // [west, south, east, north]
  center: { lat: number; lng: number };
  defaultZoom: number;
  description: string;           // 1-3 sentences, used in intro + meta
  bestSeason?: string;           // 'May – October'
}

export const REGIONS: readonly Region[] = [
  { slug: 'beskydy', country: 'cz', name: 'Beskydy', … },
  { slug: 'jeseniky', country: 'cz', name: 'Jeseníky', … },
  { slug: 'tyrol', country: 'at', name: 'Tyrol', … },
  { slug: 'alpine-passes', country: 'at', parent: 'tyrol',
    name: 'Alpine Passes', … },
  // ~5-10 curated entries for the initial release
];

export const COUNTRIES: Record<string, { name: string; flag?: string }> = {
  cz: { name: 'Czech Republic' },
  at: { name: 'Austria' },
  // …
};

// Helpers used by both the companion and the backend:
export function findRegion(country: string, slug: string): Region | undefined;
export function findCountryRegions(country: string): Region[];
export function findSubRegions(country: string, parent: string): Region[];
```

Why a TypeScript catalog rather than a DB table:

- No new migration / schema change.
- Catalog is the source of truth for the companion's `generateStaticParams`
  _and_ the backend validator, without a runtime DB round-trip.
- Curation is deliberate and small (under ~20 regions for MVP), so code review
  is a fine editorial workflow.

### Backend: `GET /roads/best`

New endpoint on the existing roads module. Public, throttled by the default
limit (60 req/min); no auth required.

**Request**

```
GET /roads/best?country=cz&region=beskydy&limit=10
```

**Query DTO** (`apps/backend/src/modules/roads/dto/query-best-roads.dto.ts`):

- `country` — required, 2-char ISO alpha-2 (lowercased), validated via
  `@Matches(/^[a-z]{2}$/)`
- `region` — required, slug (1-60 chars, `[a-z0-9-]+`)
- `limit` — optional, default 10, max 50

The controller rejects `country`/`region` combinations not found in the
catalog with 404; this mirrors how `findById` returns 404 for missing
segment ids and prevents arbitrary bbox DoS.

**Response DTO**:

```ts
class BestRoadsResponseDto {
  region: {
    slug: string;
    country: string;
    name: string;
    bbox: [number, number, number, number];
  };
  roads: BestRoadDto[]; // ordered highest score first
}

class BestRoadDto {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
  geometry: { lat: number; lng: number }[]; // simplified GeoJSON → array
  best_score: number; // composite ranking score (opaque, for debugging)
}
```

**Service query** (`RoadsService.findBest(country, region, limit)`):

Resolve region from the catalog (imported from `@tarmoto/shared`). Then:

```sql
SELECT
  rs.id, rs.road_name, rs.road_number,
  rs.quality_score, rs.curviness_score, rs.surface_type,
  rs.length_m, rs.confidence,
  ST_AsGeoJSON(rs.geom)::json AS geojson,
  -- composite score: quality weighted heaviest, curviness next, length
  -- is a light tie-breaker so we don't flood the list with 200m slivers.
  (
    COALESCE(rs.quality_score, 0) * 2.0
    + rs.curviness_score * 1.0
    + LEAST(rs.length_m / 1000.0, 20.0) * 0.1
  ) AS best_score
FROM road_segments rs
WHERE ST_Intersects(
  rs.geom,
  ST_MakeEnvelope($1, $2, $3, $4, 4326)
)
  AND rs.quality_score IS NOT NULL
  AND rs.confidence >= $5        -- MIN_CONFIDENCE (e.g. 3)
  AND rs.length_m >= $6          -- MIN_LENGTH_M (e.g. 500)
ORDER BY best_score DESC
LIMIT $7;
```

Constants live at the top of the service. The confidence/length filters
prevent thin or under-sampled segments from dominating an otherwise empty
region.

Geometry is returned as an array of `{ lat, lng }` points (matching
`RoadSegmentDetailDto.geometry`) so the companion can draw it directly on
MapLibre without parsing GeoJSON on the client.

**OpenAPI**: add the endpoint + DTOs to the generated spec. Regenerate
`packages/openapi/types.ts` via `pnpm --filter @tarmoto/openapi generate`.

### Companion: page components

```
apps/companion/src/app/roads/best/
  layout.tsx                     # public-aware chrome (mirrors /explore)
  page.tsx                       # hub: list of all countries
  [country]/
    page.tsx                     # lists regions in the country
  [country]/[region]/
    page.tsx                     # the Best Roads page
    _components/
      BestRoadsMap.tsx           # MapLibre preview, polylines from server data
      BestRoadsList.tsx          # ranked table with badges
      BestRoadsSchemaOrg.tsx     # JSON-LD <script type="application/ld+json">
  [country]/[region]/[subregion]/
    page.tsx                     # sub-region: same shape as region page
```

Each route uses the Next 15 App Router with:

- `generateStaticParams()` → iterates `REGIONS` from `@tarmoto/shared`
- `generateMetadata()` → title, description, canonical URL, OG tags
- Page body renders: hero (region name + description + best season),
  map preview, ranked list, CTA, JSON-LD block
- `export const revalidate = 604800;` (weekly ISR)

Data fetching runs on the server via a new thin helper
`apps/companion/src/lib/bestRoads.ts` that calls the backend endpoint with
`fetch()` and an `Authorization`-less request (endpoint is public). Errors
during SSR produce a `notFound()` so invalid region slugs cleanly render a 404.

### MapLibre preview

`BestRoadsMap.tsx` is a client component. It:

- Takes `region.bbox`, `region.center`, `region.defaultZoom`, and the ranked
  `roads[]` with geometries as props.
- Renders a MapLibre map fitted to the bbox.
- Adds a GeoJSON source with the road polylines colored by quality (reusing
  the existing `QUALITY_*` color tokens in `globals.css`).
- Adds numbered markers at each polyline midpoint showing the rank (1-N).

No new tile source is needed — this is a static subset rendered directly
from server-provided geometries, not the `/roads/tiles` vector layer. Map
style reuses `QualityMap`'s base style.

The map is non-interactive beyond pan/zoom (no filter controls, no hazard
overlay). Clicking a polyline or rank marker scrolls to that row in
`BestRoadsList`.

### Structured data (JSON-LD)

`BestRoadsSchemaOrg.tsx` renders a single `<script type="application/ld+json">`
tag with:

```json
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Best Roads in Beskydy",
  "description": "…",
  "numberOfItems": 10,
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "item": {
        "@type": "TouristAttraction",
        "name": "Lysá hora road",
        "description": "Quality 4.6 · Curviness 3.8 · 12.4 km",
        "touristType": "Motorcyclist"
      }
    },
    …
  ]
}
```

Plus a `BreadcrumbList` linking the page to its country and the top-level
hub, so Google can render breadcrumb snippets.

### Sitemap & robots

Extend `apps/companion/src/app/sitemap.ts` to include, for every region in
the catalog:

- `/roads/best`
- `/roads/best/{country}`
- `/roads/best/{country}/{region}`
- `/roads/best/{country}/{region}/{subregion}` (where applicable)

All with `changeFrequency: "weekly"` and `priority: 0.8` (just below `/explore`).

Extend `robots.ts` `allow:` to include `/roads`. Extend `middleware.ts`
`PUBLIC_PATHS` to include `/roads/best`.

## Error handling

- **Unknown country/region slug** → backend returns 404, companion
  `getStaticParams` filters to known slugs only, runtime fallback calls
  `notFound()` to render the Next.js 404 page.
- **Backend unreachable during SSR** → page throws, Next serves the error
  boundary (500); ISR means subsequent requests keep serving the last
  successful render until the backend recovers.
- **Empty result set** (region has < 3 qualifying segments) → page renders
  with a "coming soon — not enough data yet" empty state and a CTA to
  contribute rides. Still indexable so the URL remains stable.

## Data / scoring concerns

The composite score is deliberately simple and documented inline. It does
**not** incorporate popularity or hazard density yet — those exist but are
noisy on a 10-entry list. Filed in follow-ups if rankings look wrong after
the first week of real data.

A region with `confidence` filter of 3 excludes segments seen by only 1-2
raters; raise/lower via the top-of-file constant if the initial launch
reveals empty regions.

## Testing strategy

- **Backend unit**: extend `roads.service.spec.ts` with `findBest` cases:
  ordering correctness, confidence filter, length filter, unknown region →
  404, empty result pass-through.
- **Backend e2e** (if feasible with the current harness): one happy-path
  integration test asserting the response shape against OpenAPI.
- **Companion**: no Vitest harness exists (per US-47 precedent), so we rely
  on TypeScript compile + lint + `pnpm build:companion` succeeding. Manual
  verification uses `pnpm dev:companion` and a seeded local DB for one
  region.
- **Catalog sanity**: a backend unit test or lightweight
  `packages/shared/src/regions.test.ts` that asserts no duplicate slugs,
  every `parent` resolves, and every `bbox` is geographically valid
  (west < east, south < north).

## Verification commands

```bash
pnpm lint
pnpm build:shared && pnpm --filter @tarmoto/openapi generate
pnpm build:backend && pnpm --filter @tarmoto/backend test
pnpm build:companion
```

Manual:

1. `pnpm db:up && pnpm db:migrate` (with seed data for one region bbox)
2. `pnpm dev:backend` and `curl '/roads/best?country=cz&region=beskydy'`
3. `pnpm dev:companion` — browse to `/roads/best/cz/beskydy`, inspect
   `view-source:` for the JSON-LD block, confirm sitemap entries render at
   `/sitemap.xml`.

## Follow-ups filed separately

1. **Photos**: add photo slots to Best Roads page once a road/region photo
   pipeline lands (likely piggybacks on road reviews).
2. **Trip planner CTA destination**: make the CTA functional once
   WEB-EPIC 1 ships.
3. **Popularity-weighted scoring**: incorporate ride counts once rankings
   need tuning.
4. **Region CMS**: move regions to a DB table if editorial volume grows
   beyond what fits comfortably in code review.

## Touched files (summary)

New:

- `packages/shared/src/regions.ts`
- `packages/shared/src/regions.test.ts` _(optional, for sanity checks)_
- `apps/backend/src/modules/roads/dto/query-best-roads.dto.ts`
- `apps/backend/src/modules/roads/dto/best-roads.dto.ts`
- `apps/companion/src/app/roads/best/layout.tsx`
- `apps/companion/src/app/roads/best/page.tsx`
- `apps/companion/src/app/roads/best/[country]/page.tsx`
- `apps/companion/src/app/roads/best/[country]/[region]/page.tsx`
- `apps/companion/src/app/roads/best/[country]/[region]/[subregion]/page.tsx`
- `apps/companion/src/app/roads/best/[country]/[region]/_components/{BestRoadsMap,BestRoadsList,BestRoadsSchemaOrg}.tsx`
- `apps/companion/src/lib/bestRoads.ts`

Modified:

- `packages/shared/src/index.ts` — export regions
- `apps/backend/src/modules/roads/roads.controller.ts` — new endpoint
- `apps/backend/src/modules/roads/roads.service.ts` — `findBest`
- `apps/backend/src/modules/roads/roads.service.spec.ts` — tests
- `apps/companion/src/middleware.ts` — add `/roads/best` to PUBLIC_PATHS
- `apps/companion/src/app/sitemap.ts` — include region URLs
- `apps/companion/src/app/robots.ts` — allow `/roads`
- `packages/openapi/openapi.yaml` _(generated)_ — new endpoint + types
- `packages/openapi/types.ts` _(generated)_
