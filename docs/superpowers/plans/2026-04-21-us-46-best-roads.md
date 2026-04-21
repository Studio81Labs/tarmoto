# US-46 Best Roads SEO Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship auto-generated "Best Roads in &lt;region&gt;" SEO pages under
`/roads/best/[country]/[region]` for the Tarmoto companion, backed by a new
public `GET /roads/best` endpoint and a curated region catalog in
`@tarmoto/shared`.

**Architecture:** A hand-curated `REGIONS` catalog in `packages/shared` feeds
both the backend validator and the companion's `generateStaticParams`. The
backend adds one endpoint that scores and returns top-N road segments within
a region's bbox. The companion renders SSR pages with weekly ISR, Schema.org
JSON-LD, and a MapLibre preview drawn from the endpoint's returned
geometries — no new tile source, no DB migration.

**Tech Stack:** TypeScript, NestJS 11 (Swagger + class-validator), TypeORM +
PostGIS, Next.js 15 (App Router), MapLibre GL 4.

**Reference:** Design spec at [docs/superpowers/specs/2026-04-21-us-46-best-roads-design.md](../specs/2026-04-21-us-46-best-roads-design.md). Issue: [#58](https://github.com/Studio81Labs/tarmoto/issues/58).

---

## File Structure

**Created:**

- `packages/shared/src/regions.ts` — Region/Country types + `REGIONS` catalog + helpers + startup validation
- `apps/backend/src/modules/roads/dto/query-best-roads.dto.ts` — query DTO
- `apps/backend/src/modules/roads/dto/best-roads.dto.ts` — response DTOs
- `apps/companion/src/lib/bestRoads.ts` — server-side fetch helper
- `apps/companion/src/app/roads/best/layout.tsx` — public-aware chrome
- `apps/companion/src/app/roads/best/page.tsx` — hub (list of countries)
- `apps/companion/src/app/roads/best/[country]/page.tsx` — country page
- `apps/companion/src/app/roads/best/[country]/[region]/page.tsx` — region page
- `apps/companion/src/app/roads/best/[country]/[region]/[subregion]/page.tsx` — sub-region page
- `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsMap.tsx`
- `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsList.tsx`
- `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsSchemaOrg.tsx`

**Modified:**

- `packages/shared/src/index.ts` — export regions
- `apps/backend/src/modules/roads/roads.service.ts` — add `findBest`
- `apps/backend/src/modules/roads/roads.service.spec.ts` — cover `findBest`
- `apps/backend/src/modules/roads/roads.controller.ts` — register endpoint
- `apps/companion/src/middleware.ts` — add `/roads/best` to PUBLIC_PATHS
- `apps/companion/src/app/sitemap.ts` — include region URLs
- `apps/companion/src/app/robots.ts` — allow `/roads`
- `packages/openapi/openapi.yaml` _(generated)_
- `packages/openapi/types.ts` _(generated)_

---

## Task 1: Shared — region catalog types, data, helpers, startup validation

**Files:**

- Create: `packages/shared/src/regions.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1.1: Write `regions.ts`**

Create `packages/shared/src/regions.ts`:

```ts
/**
 * Curated catalog of motorcycle-riding regions used by the "Best Roads"
 * SEO pages. The companion's generateStaticParams and the backend's
 * /roads/best endpoint both consume this file — a single source of truth
 * means we can change regions without migrations.
 *
 * Add a new region by appending to REGIONS (and COUNTRIES if new country).
 * Slugs are lowercase kebab-case ASCII; country codes are ISO 3166-1
 * alpha-2 lowercased.
 */

export interface Region {
  slug: string;
  country: string;
  name: string;
  /** Parent region slug for sub-regions. Undefined for top-level regions. */
  parent?: string;
  /** [west, south, east, north] in WGS84 degrees. */
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  defaultZoom: number;
  description: string;
  bestSeason?: string;
}

export interface Country {
  code: string;
  name: string;
}

export const COUNTRIES: readonly Country[] = [
  { code: "cz", name: "Czech Republic" },
  { code: "at", name: "Austria" },
  { code: "it", name: "Italy" },
];

export const REGIONS: readonly Region[] = [
  {
    slug: "beskydy",
    country: "cz",
    name: "Beskydy",
    bbox: [18.0, 49.3, 18.85, 49.7],
    center: { lat: 49.5, lng: 18.4 },
    defaultZoom: 10,
    description:
      "The Moravian-Silesian Beskydy range climbs from the Ostrava basin into " +
      "rolling forested ridgelines. Narrow ridge roads, long sweeping descents, " +
      "and the iconic climb to Lysá hora make it a favourite weekend loop.",
    bestSeason: "May – October",
  },
  {
    slug: "jeseniky",
    country: "cz",
    name: "Jeseníky",
    bbox: [16.85, 49.85, 17.6, 50.25],
    center: { lat: 50.05, lng: 17.2 },
    defaultZoom: 10,
    description:
      "Higher and colder than the Beskydy, the Jeseníky mountains offer open " +
      "highland roads over Červenohorské sedlo and the long sweeping arcs " +
      "around Praděd — the tallest peak in Moravia.",
    bestSeason: "June – September",
  },
  {
    slug: "sumava",
    country: "cz",
    name: "Šumava",
    bbox: [13.2, 48.55, 14.5, 49.35],
    center: { lat: 48.95, lng: 13.85 },
    defaultZoom: 9,
    description:
      "Long, quiet forest roads trace the Czech-Bavarian border through the " +
      "Šumava national park. Lower elevation than the Alps but rewarding for " +
      "pure riding flow over long distances.",
    bestSeason: "May – October",
  },
  {
    slug: "tyrol",
    country: "at",
    name: "Tyrol",
    bbox: [10.1, 46.65, 12.8, 47.7],
    center: { lat: 47.2, lng: 11.4 },
    defaultZoom: 8,
    description:
      "The heart of the Austrian Alps. Hairpin-stitched passes, glacier-fed " +
      "valleys and the highest paved road in Austria — Tyrol packs more " +
      "legendary motorcycle roads into one province than most countries.",
    bestSeason: "June – September",
  },
  {
    slug: "alpine-passes",
    country: "at",
    parent: "tyrol",
    name: "Alpine Passes",
    bbox: [10.5, 46.8, 12.5, 47.4],
    center: { lat: 47.1, lng: 11.5 },
    defaultZoom: 9,
    description:
      "The signature high passes of Tyrol — Timmelsjoch, Hahntennjoch, " +
      "Silvretta-Hochalpenstraße — collected onto a single route list.",
    bestSeason: "July – September",
  },
  {
    slug: "dolomites",
    country: "it",
    name: "Dolomites",
    bbox: [10.8, 46.2, 12.5, 46.85],
    center: { lat: 46.5, lng: 11.75 },
    defaultZoom: 9,
    description:
      "Jagged limestone spires frame a web of hairpin roads — Passo Pordoi, " +
      "Passo Sella, Passo Giau — each a riding pilgrimage in its own right.",
    bestSeason: "June – September",
  },
];

export function findCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

export function findRegion(country: string, slug: string): Region | undefined {
  return REGIONS.find((r) => r.country === country && r.slug === slug);
}

export function findCountryRegions(country: string): Region[] {
  return REGIONS.filter((r) => r.country === country && !r.parent);
}

export function findSubRegions(country: string, parent: string): Region[] {
  return REGIONS.filter((r) => r.country === country && r.parent === parent);
}

export function listIndexableRegions(): Region[] {
  return [...REGIONS];
}

/**
 * Run at module load to catch catalog typos immediately — duplicate slugs,
 * unknown country codes, unresolved parents, inside-out bboxes. Any error
 * here fails the build of whichever package imports the catalog.
 */
function assertCatalogValid(): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  const countryCodes = new Set(COUNTRIES.map((c) => c.code));

  for (const r of REGIONS) {
    const key = `${r.country}/${r.slug}`;
    if (seen.has(key)) errors.push(`duplicate region: ${key}`);
    seen.add(key);
    if (!countryCodes.has(r.country)) {
      errors.push(`unknown country '${r.country}' on region ${r.slug}`);
    }
    const [w, s, e, n] = r.bbox;
    if (!(w < e && s < n)) {
      errors.push(`invalid bbox on ${key}: [${w},${s},${e},${n}]`);
    }
  }
  for (const r of REGIONS) {
    if (r.parent) {
      const parent = REGIONS.find(
        (p) => p.country === r.country && p.slug === r.parent,
      );
      if (!parent) {
        errors.push(
          `region ${r.country}/${r.slug} has unresolved parent '${r.parent}'`,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`regions catalog invalid:\n  ${errors.join("\n  ")}`);
  }
}
assertCatalogValid();
```

- [ ] **Step 1.2: Export regions from the shared barrel**

Edit `packages/shared/src/index.ts`:

```ts
/**
 * @tarmoto/shared
 * Shared types, constants, and DTOs for Tarmoto.
 */

export * from "./constants";
export * from "./geo";
export * from "./units";
export * from "./regions";
```

- [ ] **Step 1.3: Build the shared package**

Run: `pnpm --filter @tarmoto/shared build`
Expected: success, no errors. Any catalog typo throws at build time.

- [ ] **Step 1.4: Commit**

```bash
git add packages/shared/src/regions.ts packages/shared/src/index.ts
git commit -m "feat(shared): add curated region catalog for best-roads pages"
```

---

## Task 2: Backend — DTOs for the new endpoint

**Files:**

- Create: `apps/backend/src/modules/roads/dto/query-best-roads.dto.ts`
- Create: `apps/backend/src/modules/roads/dto/best-roads.dto.ts`

- [ ] **Step 2.1: Write the query DTO**

Create `apps/backend/src/modules/roads/dto/query-best-roads.dto.ts`:

```ts
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class QueryBestRoadsDto {
  @ApiProperty({
    description: "ISO 3166-1 alpha-2 country code, lowercased",
    example: "cz",
  })
  @IsString()
  @Matches(/^[a-z]{2}$/)
  country!: string;

  @ApiProperty({
    description: "Region slug (kebab-case)",
    example: "beskydy",
  })
  @IsString()
  @Matches(/^[a-z0-9-]{1,60}$/)
  region!: string;

  @ApiProperty({
    description: "Maximum roads to return",
    default: 10,
    required: false,
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
```

- [ ] **Step 2.2: Write the response DTOs**

Create `apps/backend/src/modules/roads/dto/best-roads.dto.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";

export class BestRoadsRegionDto {
  @ApiProperty({ example: "beskydy" })
  slug!: string;

  @ApiProperty({ example: "cz" })
  country!: string;

  @ApiProperty({ example: "Beskydy" })
  name!: string;

  @ApiProperty({
    type: [Number],
    description: "[west, south, east, north] in WGS84 degrees",
    example: [18.0, 49.3, 18.85, 49.7],
  })
  bbox!: [number, number, number, number];
}

export class BestRoadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  road_name!: string | null;

  @ApiProperty({ nullable: true })
  road_number!: string | null;

  @ApiProperty({ description: "1-5 scale", nullable: true })
  quality_score!: number | null;

  @ApiProperty({ description: "0-5 scale" })
  curviness_score!: number;

  @ApiProperty()
  surface_type!: string;

  @ApiProperty({ description: "Segment length in metres" })
  length_m!: number;

  @ApiProperty({ description: "0-100 confidence score" })
  confidence!: number;

  @ApiProperty({
    type: [Object],
    description:
      "Polyline of { lat, lng } points, ordered along direction of travel",
  })
  geometry!: Array<{ lat: number; lng: number }>;

  @ApiProperty({
    description: "Composite best-road ranking score (opaque, for debugging)",
  })
  best_score!: number;
}

export class BestRoadsResponseDto {
  @ApiProperty({ type: BestRoadsRegionDto })
  region!: BestRoadsRegionDto;

  @ApiProperty({ type: [BestRoadDto] })
  roads!: BestRoadDto[];
}
```

- [ ] **Step 2.3: Commit**

```bash
git add apps/backend/src/modules/roads/dto/query-best-roads.dto.ts \
        apps/backend/src/modules/roads/dto/best-roads.dto.ts
git commit -m "feat(backend): add best-roads DTOs for /roads/best endpoint"
```

---

## Task 3: Backend — `RoadsService.findBest` (TDD)

**Files:**

- Modify: `apps/backend/src/modules/roads/roads.service.ts`
- Modify: `apps/backend/src/modules/roads/roads.service.spec.ts`

- [ ] **Step 3.1: Write failing tests for `findBest`**

Append to `apps/backend/src/modules/roads/roads.service.spec.ts`, inside
the outer `describe('RoadsService', …)`, after the existing `findFunZones`
block (or at the end, just before the outer describe's closing `});`):

```ts
describe("findBest", () => {
  it("resolves the region and issues a bbox query with the composite score", async () => {
    (segmentRepo.query as jest.Mock).mockResolvedValueOnce([]);

    await service.findBest({ country: "cz", region: "beskydy" });

    expect(segmentRepo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (segmentRepo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain("ST_Intersects");
    expect(sql).toContain("ST_MakeEnvelope");
    expect(sql).toContain("best_score");
    // bbox params for Beskydy from the regions catalog
    expect(params.slice(0, 4)).toEqual([18.0, 49.3, 18.85, 49.7]);
    // default limit (last param) = 10
    expect(params[params.length - 1]).toBe(10);
  });

  it("honours a custom limit up to the DTO-validated max", async () => {
    (segmentRepo.query as jest.Mock).mockResolvedValueOnce([]);
    await service.findBest({ country: "cz", region: "beskydy", limit: 25 });
    const [, params] = (segmentRepo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(params[params.length - 1]).toBe(25);
  });

  it("throws NotFoundException for an unknown region", async () => {
    await expect(
      service.findBest({ country: "cz", region: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(segmentRepo.query).not.toHaveBeenCalled();
  });

  it("maps SQL rows into BestRoadDto with geometry as {lat,lng}[]", async () => {
    (segmentRepo.query as jest.Mock).mockResolvedValueOnce([
      {
        id: "seg-1",
        road_name: "Test Road",
        road_number: null,
        quality_score: 4.5,
        curviness_score: 3.2,
        surface_type: "asphalt",
        length_m: 5400,
        confidence: 42,
        geojson: {
          type: "LineString",
          coordinates: [
            [18.4, 49.5],
            [18.41, 49.51],
          ],
        },
        best_score: 12.34,
      },
    ]);

    const result = await service.findBest({
      country: "cz",
      region: "beskydy",
    });

    expect(result.region.slug).toBe("beskydy");
    expect(result.region.bbox).toEqual([18.0, 49.3, 18.85, 49.7]);
    expect(result.roads).toHaveLength(1);
    expect(result.roads[0]).toMatchObject({
      id: "seg-1",
      road_name: "Test Road",
      quality_score: 4.5,
      surface_type: "asphalt",
    });
    expect(result.roads[0].geometry).toEqual([
      { lat: 49.5, lng: 18.4 },
      { lat: 49.51, lng: 18.41 },
    ]);
  });
});
```

- [ ] **Step 3.2: Run the tests to verify they fail**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=roads.service`

Expected: all four new tests FAIL (`findBest is not a function` or similar).

- [ ] **Step 3.3: Implement `findBest` in the service**

Edit `apps/backend/src/modules/roads/roads.service.ts`.

Add imports at the top of the file (after existing imports):

```ts
import { findRegion } from "@tarmoto/shared";
import { QueryBestRoadsDto } from "./dto/query-best-roads.dto.js";
import { BestRoadsResponseDto, BestRoadDto } from "./dto/best-roads.dto.js";
```

Below the existing `RECENT_REVIEW_LIMIT` / `ACTIVE_HAZARD_LIMIT` constants,
add:

```ts
const BEST_ROADS_MIN_CONFIDENCE = 3;
const BEST_ROADS_MIN_LENGTH_M = 500;
const BEST_ROADS_DEFAULT_LIMIT = 10;
```

Add the method inside the `RoadsService` class, directly after
`findFunZones`:

```ts
async findBest(query: QueryBestRoadsDto): Promise<BestRoadsResponseDto> {
  const region = findRegion(query.country, query.region);
  if (!region) {
    throw new NotFoundException('Region not found');
  }
  const limit = query.limit ?? BEST_ROADS_DEFAULT_LIMIT;
  const [w, s, e, n] = region.bbox;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rows = await this.segmentRepo.query(
    `SELECT
      rs.id, rs.road_name, rs.road_number,
      rs.quality_score, rs.curviness_score, rs.surface_type,
      rs.length_m, rs.confidence,
      ST_AsGeoJSON(rs.geom)::json AS geojson,
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
      AND rs.confidence >= $5
      AND rs.length_m >= $6
    ORDER BY best_score DESC
    LIMIT $7`,
    [w, s, e, n, BEST_ROADS_MIN_CONFIDENCE, BEST_ROADS_MIN_LENGTH_M, limit],
  );

  const roads: BestRoadDto[] = (rows as Record<string, unknown>[]).map(
    (row) => {
      const geojson = row.geojson as { coordinates: number[][] };
      return {
        id: row.id as string,
        road_name: (row.road_name as string) ?? null,
        road_number: (row.road_number as string) ?? null,
        quality_score: (row.quality_score as number) ?? null,
        curviness_score: row.curviness_score as number,
        surface_type: row.surface_type as string,
        length_m: row.length_m as number,
        confidence: row.confidence as number,
        geometry: geojson.coordinates.map((c) => ({ lat: c[1], lng: c[0] })),
        best_score: row.best_score as number,
      };
    },
  );

  return {
    region: {
      slug: region.slug,
      country: region.country,
      name: region.name,
      bbox: region.bbox,
    },
    roads,
  };
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=roads.service`

Expected: all existing + new tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/backend/src/modules/roads/roads.service.ts \
        apps/backend/src/modules/roads/roads.service.spec.ts
git commit -m "feat(backend): rank top road segments per region via /roads/best"
```

---

## Task 4: Backend — controller endpoint

**Files:**

- Modify: `apps/backend/src/modules/roads/roads.controller.ts`

- [ ] **Step 4.1: Register the new endpoint**

Edit `apps/backend/src/modules/roads/roads.controller.ts`. Add imports at
the top:

```ts
import { QueryBestRoadsDto } from "./dto/query-best-roads.dto.js";
import { BestRoadsResponseDto } from "./dto/best-roads.dto.js";
```

Add the handler **before** the existing `@Get(':segmentId')` method —
NestJS matches routes top-down, so `/roads/best` must be declared before
the `:segmentId` param route or it would be swallowed as an id:

```ts
@Get('best')
@ApiOperation({
  summary: 'Get top-ranked road segments for a curated region',
})
@ApiResponse({ status: 200, type: BestRoadsResponseDto })
@ApiResponse({ status: 404, description: 'Region not found' })
async findBest(
  @Query() query: QueryBestRoadsDto,
): Promise<BestRoadsResponseDto> {
  return this.roadsService.findBest(query);
}
```

Double-check the final controller method order is:
`findNearby` → `findFunZones` → `findBest` → `findById`.

- [ ] **Step 4.2: Run the backend build to confirm the endpoint compiles**

Run: `pnpm build:backend`
Expected: clean build.

- [ ] **Step 4.3: Commit**

```bash
git add apps/backend/src/modules/roads/roads.controller.ts
git commit -m "feat(backend): expose GET /roads/best endpoint"
```

---

## Task 5: Regenerate OpenAPI types

**Files:**

- Modify (generated): `packages/openapi/openapi.yaml`, `packages/openapi/types.ts`

- [ ] **Step 5.1: Regenerate**

Run: `pnpm generate:api`

If this fails because `dist/` is stale, run: `pnpm build:shared && pnpm generate:api`.

Expected: `packages/openapi/openapi.yaml` and `types.ts` updated with
`/roads/best`, `QueryBestRoadsDto`, `BestRoadDto`, `BestRoadsResponseDto`.

- [ ] **Step 5.2: Commit**

```bash
git add packages/openapi/openapi.yaml packages/openapi/types.ts
git commit -m "chore(openapi): regenerate for /roads/best endpoint"
```

---

## Task 6: Companion — middleware + robots + sitemap

**Files:**

- Modify: `apps/companion/src/middleware.ts`
- Modify: `apps/companion/src/app/robots.ts`
- Modify: `apps/companion/src/app/sitemap.ts`

- [ ] **Step 6.1: Allow `/roads/best` through auth middleware**

Edit `apps/companion/src/middleware.ts`:

```ts
const PUBLIC_PATHS = ["/explore", "/roads/best"];
```

- [ ] **Step 6.2: Update robots.ts**

Edit `apps/companion/src/app/robots.ts`. Update the `allow` array:

```ts
allow: ["/", "/explore", "/roads/best", "/login", "/register"],
```

Leave the `disallow` list untouched.

- [ ] **Step 6.3: Extend the sitemap**

Replace `apps/companion/src/app/sitemap.ts` with:

```ts
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { COUNTRIES, listIndexableRegions } from "@tarmoto/shared";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    {
      url: `${base}/explore`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${base}/roads/best`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.85,
    },
    {
      url: `${base}/login`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/register`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  const countryEntries: MetadataRoute.Sitemap = COUNTRIES.map((c) => ({
    url: `${base}/roads/best/${c.code}`,
    lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  const regionEntries: MetadataRoute.Sitemap = listIndexableRegions().map(
    (r) => ({
      url: r.parent
        ? `${base}/roads/best/${r.country}/${r.parent}/${r.slug}`
        : `${base}/roads/best/${r.country}/${r.slug}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }),
  );

  return [...staticEntries, ...countryEntries, ...regionEntries];
}
```

- [ ] **Step 6.4: Commit**

```bash
git add apps/companion/src/middleware.ts \
        apps/companion/src/app/robots.ts \
        apps/companion/src/app/sitemap.ts
git commit -m "feat(companion): open /roads/best to crawlers and sitemap"
```

---

## Task 7: Companion — fetch helper + layout + hub page

**Files:**

- Create: `apps/companion/src/lib/bestRoads.ts`
- Create: `apps/companion/src/app/roads/best/layout.tsx`
- Create: `apps/companion/src/app/roads/best/page.tsx`

- [ ] **Step 7.1: Write the server-side fetch helper**

Create `apps/companion/src/lib/bestRoads.ts`:

```ts
import { API_BASE_SERVER } from "@/lib/config";
import type { paths } from "@tarmoto/openapi/types";

type BestRoadsResponse =
  paths["/roads/best"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Server-side fetcher used by the SSR region pages. The /roads/best endpoint
 * is public, so no Authorization header is needed. Returns null on 404
 * (unknown region) so callers can call Next's notFound() cleanly.
 */
export async function fetchBestRoads(
  country: string,
  region: string,
  limit = 10,
): Promise<BestRoadsResponse | null> {
  const url =
    `${API_BASE_SERVER}/roads/best` +
    `?country=${encodeURIComponent(country)}` +
    `&region=${encodeURIComponent(region)}` +
    `&limit=${limit}`;

  const res = await fetch(url, {
    next: { revalidate: 604800 },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /roads/best failed (${res.status})`);
  }
  return (await res.json()) as BestRoadsResponse;
}
```

- [ ] **Step 7.2: Write the public-aware layout**

Create `apps/companion/src/app/roads/best/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { siteUrl } from "@/lib/site";
import { PublicExploreHeader } from "../../explore/_components/PublicExploreHeader";

const title = "Best Motorcycle Roads — Tarmoto";
const description =
  "Curated lists of the highest-rated motorcycle roads in each region, " +
  "ranked by quality and curviness from crowdsourced rider data.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title,
  description,
  alternates: { canonical: "/roads/best" },
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "Tarmoto",
    url: "/roads/best",
  },
  twitter: { card: "summary_large_image", title, description },
};

export default async function BestRoadsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (session?.user) {
    return <AppShell>{children}</AppShell>;
  }
  return (
    <div className="flex flex-col min-h-screen bg-slate-950">
      <PublicExploreHeader />
      <div className="flex-1">{children}</div>
    </div>
  );
}
```

- [ ] **Step 7.3: Write the hub page (`/roads/best`)**

Create `apps/companion/src/app/roads/best/page.tsx`:

```tsx
import Link from "next/link";
import { COUNTRIES, findCountryRegions } from "@tarmoto/shared";

export const revalidate = 604800;

export default function BestRoadsHubPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Best motorcycle roads
        </h1>
        <p className="mt-2 text-slate-400">
          Browse curated lists of top-ranked roads — scored from live road
          quality and curviness data. Pick a country to get started.
        </p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {COUNTRIES.map((country) => {
          const regionCount = findCountryRegions(country.code).length;
          return (
            <li key={country.code}>
              <Link
                href={`/roads/best/${country.code}`}
                className="block rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-800/60 transition"
              >
                <h2 className="text-xl font-semibold">{country.name}</h2>
                <p className="mt-1 text-sm text-slate-400">
                  {regionCount} region{regionCount === 1 ? "" : "s"}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
```

- [ ] **Step 7.4: Commit**

```bash
git add apps/companion/src/lib/bestRoads.ts \
        apps/companion/src/app/roads/best/layout.tsx \
        apps/companion/src/app/roads/best/page.tsx
git commit -m "feat(companion): add /roads/best hub page + public layout"
```

---

## Task 8: Companion — country page

**Files:**

- Create: `apps/companion/src/app/roads/best/[country]/page.tsx`

- [ ] **Step 8.1: Write the country page**

Create `apps/companion/src/app/roads/best/[country]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { COUNTRIES, findCountry, findCountryRegions } from "@tarmoto/shared";

export const revalidate = 604800;

export function generateStaticParams() {
  return COUNTRIES.map((c) => ({ country: c.code }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string }>;
}): Promise<Metadata> {
  const { country } = await params;
  const c = findCountry(country);
  if (!c) return {};
  const title = `Best motorcycle roads in ${c.name} — Tarmoto`;
  const description = `Ranked lists of the top-rated motorcycle roads in ${c.name}, scored by quality and curviness.`;
  return {
    title,
    description,
    alternates: { canonical: `/roads/best/${c.code}` },
    openGraph: {
      title,
      description,
      url: `/roads/best/${c.code}`,
      type: "website",
    },
  };
}

export default async function BestRoadsCountryPage({
  params,
}: {
  params: Promise<{ country: string }>;
}) {
  const { country } = await params;
  const c = findCountry(country);
  if (!c) notFound();
  const regions = findCountryRegions(c.code);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/roads/best" className="hover:text-white">
          Best roads
        </Link>
        <span className="mx-2">/</span>
        <span>{c.name}</span>
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Best motorcycle roads in {c.name}
        </h1>
        <p className="mt-2 text-slate-400">
          {regions.length} curated region{regions.length === 1 ? "" : "s"} — tap
          through for ranked roads, quality scores and a map preview.
        </p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2">
        {regions.map((r) => (
          <li key={r.slug}>
            <Link
              href={`/roads/best/${c.code}/${r.slug}`}
              className="block rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-800/60 transition"
            >
              <h2 className="text-xl font-semibold">{r.name}</h2>
              <p className="mt-1 text-sm text-slate-400 line-clamp-2">
                {r.description}
              </p>
              {r.bestSeason && (
                <p className="mt-2 text-xs text-slate-500">
                  Best season: {r.bestSeason}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 8.2: Commit**

```bash
git add apps/companion/src/app/roads/best/[country]/page.tsx
git commit -m "feat(companion): add country page listing regions at /roads/best/[country]"
```

---

## Task 9: Companion — region page components (Map, List, SchemaOrg)

**Files:**

- Create: `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsMap.tsx`
- Create: `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsList.tsx`
- Create: `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsSchemaOrg.tsx`

- [ ] **Step 9.1: Write the MapLibre preview component**

Create `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsMap.tsx`:

```tsx
"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useMemo, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { Map, Layer, Source, Marker } from "react-map-gl/maplibre";
import { MAP_STYLE_URL } from "@/lib/config";
import type { FeatureCollection, LineString } from "geojson";

interface Road {
  id: string;
  road_name: string | null;
  quality_score: number | null;
  geometry: { lat: number; lng: number }[];
}

interface Props {
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  defaultZoom: number;
  roads: Road[];
}

// Keep in sync with the quality tier colors used on the explorer heatmap.
const QUALITY_COLOR = (q: number | null): string => {
  if (q == null) return "#64748B";
  if (q >= 4.5) return "#22C55E"; // excellent
  if (q >= 3.5) return "#84CC16"; // good
  if (q >= 2.5) return "#EAB308"; // fair
  if (q >= 1.5) return "#F97316"; // poor
  return "#EF4444"; // very_poor
};

export function BestRoadsMap({ bbox, center, defaultZoom, roads }: Props) {
  const mapRef = useRef<MapRef | null>(null);

  const featureCollection = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: "FeatureCollection",
      features: roads.map((r, i) => ({
        type: "Feature",
        properties: {
          id: r.id,
          rank: i + 1,
          color: QUALITY_COLOR(r.quality_score),
        },
        geometry: {
          type: "LineString",
          coordinates: r.geometry.map((p) => [p.lng, p.lat]),
        },
      })),
    }),
    [roads],
  );

  const markers = useMemo(
    () =>
      roads.map((r, i) => {
        const mid = r.geometry[Math.floor(r.geometry.length / 2)];
        return { id: r.id, rank: i + 1, lat: mid.lat, lng: mid.lng };
      }),
    [roads],
  );

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border border-slate-800">
      <Map
        ref={mapRef}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: defaultZoom,
        }}
        mapStyle={MAP_STYLE_URL}
        style={{ width: "100%", height: "100%" }}
        attributionControl={{ compact: true }}
        onLoad={() => {
          mapRef.current?.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 40, duration: 0 },
          );
        }}
      >
        <Source id="best-roads" type="geojson" data={featureCollection}>
          <Layer
            id="best-roads-line"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": 4,
              "line-opacity": 0.9,
            }}
            layout={{ "line-cap": "round", "line-join": "round" }}
          />
        </Source>
        {markers.map((m) => (
          <Marker key={m.id} latitude={m.lat} longitude={m.lng} anchor="center">
            <a
              href={`#road-${m.id}`}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white ring-2 ring-tarmoto-cyan"
            >
              {m.rank}
            </a>
          </Marker>
        ))}
      </Map>
    </div>
  );
}
```

- [ ] **Step 9.2: Write the ranked list component**

Create `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsList.tsx`:

```tsx
interface Road {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
}

interface Props {
  roads: Road[];
}

function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatQuality(q: number | null): string {
  return q == null ? "—" : q.toFixed(1);
}

export function BestRoadsList({ roads }: Props) {
  if (roads.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400">
        <p className="text-lg font-semibold">Not enough data yet</p>
        <p className="mt-2 text-sm">
          This region needs more rides before we can rank its roads. Take a ride
          through and help build the map.
        </p>
      </div>
    );
  }

  return (
    <ol className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
      {roads.map((r, i) => {
        const name =
          r.road_name ??
          (r.road_number
            ? `Road ${r.road_number}`
            : `Segment ${r.id.slice(0, 6)}`);
        return (
          <li
            key={r.id}
            id={`road-${r.id}`}
            className="flex items-center gap-4 p-4"
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-tarmoto-cyan">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold">{name}</h3>
              <p className="text-xs text-slate-400">
                {formatLength(r.length_m)} · {r.surface_type}
              </p>
            </div>
            <dl className="hidden gap-6 sm:flex">
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  Quality
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {formatQuality(r.quality_score)}
                </dd>
              </div>
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  Curviness
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {r.curviness_score.toFixed(1)}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 9.3: Write the Schema.org JSON-LD component**

JSON-LD must sit in the initial HTML for crawlers, which means an inline
`<script>` tag. We use `dangerouslySetInnerHTML` — all content is
server-generated from the catalog + backend response (no user input
today), but we still defensively escape `<` to `\u003c` so any road name
containing `</script>` can't close the block.

Create `apps/companion/src/app/roads/best/[country]/[region]/_components/BestRoadsSchemaOrg.tsx`:

```tsx
interface Road {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  length_m: number;
}

interface Props {
  regionName: string;
  countryName: string;
  countryCode: string;
  regionSlug: string;
  parentSlug?: string;
  pageUrl: string;
  description: string;
  roads: Road[];
}

/**
 * Serialises a JSON-LD payload for inline injection. Replaces every `<`
 * with `\u003c` so a pathological road name or description containing
 * `</script>` can't terminate the surrounding script block.
 */
function serializeLd(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export function BestRoadsSchemaOrg({
  regionName,
  countryName,
  countryCode,
  regionSlug,
  parentSlug,
  pageUrl,
  description,
  roads,
}: Props) {
  const origin = pageUrl.replace(/\/roads\/best.*$/, "");

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Best motorcycle roads in ${regionName}`,
    description,
    numberOfItems: roads.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: roads.map((r, i) => {
      const name =
        r.road_name ??
        (r.road_number
          ? `Road ${r.road_number}`
          : `Segment ${r.id.slice(0, 6)}`);
      const km = (r.length_m / 1000).toFixed(1);
      const quality = r.quality_score?.toFixed(1) ?? "unrated";
      return {
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "TouristAttraction",
          name,
          description: `Quality ${quality} · Curviness ${r.curviness_score.toFixed(1)} · ${km} km`,
          touristType: "Motorcyclist",
        },
      };
    }),
  };

  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: parentSlug
      ? [
          {
            "@type": "ListItem",
            position: 1,
            name: "Best roads",
            item: `${origin}/roads/best`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: `${origin}/roads/best/${countryCode}`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: parentSlug,
            item: `${origin}/roads/best/${countryCode}/${parentSlug}`,
          },
          {
            "@type": "ListItem",
            position: 4,
            name: regionName,
            item: `${origin}/roads/best/${countryCode}/${parentSlug}/${regionSlug}`,
          },
        ]
      : [
          {
            "@type": "ListItem",
            position: 1,
            name: "Best roads",
            item: `${origin}/roads/best`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: `${origin}/roads/best/${countryCode}`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: regionName,
            item: `${origin}/roads/best/${countryCode}/${regionSlug}`,
          },
        ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeLd(itemList) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeLd(breadcrumbs) }}
      />
    </>
  );
}
```

- [ ] **Step 9.4: Commit**

```bash
git add "apps/companion/src/app/roads/best/[country]/[region]/_components/"
git commit -m "feat(companion): add best-roads page components (map, list, JSON-LD)"
```

---

## Task 10: Companion — region page (main SEO page)

**Files:**

- Create: `apps/companion/src/app/roads/best/[country]/[region]/page.tsx`

- [ ] **Step 10.1: Write the region page**

Create `apps/companion/src/app/roads/best/[country]/[region]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import { BestRoadsMap } from "./_components/BestRoadsMap";
import { BestRoadsList } from "./_components/BestRoadsList";
import { BestRoadsSchemaOrg } from "./_components/BestRoadsSchemaOrg";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((r) => !r.parent)
    .map((r) => ({ country: r.country, region: r.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}): Promise<Metadata> {
  const { country, region } = await params;
  const r = findRegion(country, region);
  if (!r) return {};
  const title = `Best motorcycle roads in ${r.name} — Tarmoto`;
  return {
    title,
    description: r.description,
    alternates: { canonical: `/roads/best/${r.country}/${r.slug}` },
    openGraph: {
      title,
      description: r.description,
      url: `/roads/best/${r.country}/${r.slug}`,
      type: "website",
    },
  };
}

export default async function BestRoadsRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string }>;
}) {
  const { country, region } = await params;
  const regionMeta = findRegion(country, region);
  const countryMeta = findCountry(country);
  if (!regionMeta || !countryMeta) notFound();

  const payload = await fetchBestRoads(country, region, 10);
  if (!payload) notFound();

  const roads = payload.roads;
  const segmentIds = roads.map((r) => r.id).join(",");
  const pageUrl = `${siteUrl()}/roads/best/${country}/${region}`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/roads/best" className="hover:text-white">
          Best roads
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/roads/best/${country}`} className="hover:text-white">
          {countryMeta.name}
        </Link>
        <span className="mx-2">/</span>
        <span>{regionMeta.name}</span>
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Best motorcycle roads in {regionMeta.name}
        </h1>
        <p className="mt-3 max-w-3xl text-slate-300">
          {regionMeta.description}
        </p>
        {regionMeta.bestSeason && (
          <p className="mt-2 text-sm text-slate-500">
            Best season: {regionMeta.bestSeason}
          </p>
        )}
      </header>

      <section className="mb-8">
        <BestRoadsMap
          bbox={regionMeta.bbox}
          center={regionMeta.center}
          defaultZoom={regionMeta.defaultZoom}
          roads={roads}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-xl font-semibold">Ranked roads</h2>
        <BestRoadsList roads={roads} />
      </section>

      {roads.length > 0 && (
        <section className="mb-12 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">
            Plan a trip with these roads
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Pre-load this list into your trip planner to build a multi-day ride
            around them.
          </p>
          <Link
            href={`/trip-planner?segments=${segmentIds}`}
            className="mt-4 inline-flex items-center rounded-lg bg-tarmoto-cyan px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-tarmoto-cyan/90 transition"
          >
            Plan a trip with these roads
          </Link>
        </section>
      )}

      <BestRoadsSchemaOrg
        regionName={regionMeta.name}
        countryName={countryMeta.name}
        countryCode={countryMeta.code}
        regionSlug={regionMeta.slug}
        pageUrl={pageUrl}
        description={regionMeta.description}
        roads={roads}
      />
    </main>
  );
}
```

- [ ] **Step 10.2: Commit**

```bash
git add "apps/companion/src/app/roads/best/[country]/[region]/page.tsx"
git commit -m "feat(companion): add best-roads region page with map, list, JSON-LD"
```

---

## Task 11: Companion — sub-region page

**Files:**

- Create: `apps/companion/src/app/roads/best/[country]/[region]/[subregion]/page.tsx`

- [ ] **Step 11.1: Write the sub-region page**

The sub-region is just another region entry in the catalog with a `parent`.
The backend doesn't distinguish sub-regions from regions.

Create `apps/companion/src/app/roads/best/[country]/[region]/[subregion]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { findCountry, findRegion, listIndexableRegions } from "@tarmoto/shared";
import { fetchBestRoads } from "@/lib/bestRoads";
import { siteUrl } from "@/lib/site";
import { BestRoadsMap } from "../_components/BestRoadsMap";
import { BestRoadsList } from "../_components/BestRoadsList";
import { BestRoadsSchemaOrg } from "../_components/BestRoadsSchemaOrg";

export const revalidate = 604800;

export function generateStaticParams() {
  return listIndexableRegions()
    .filter((r) => !!r.parent)
    .map((r) => ({
      country: r.country,
      region: r.parent!,
      subregion: r.slug,
    }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}): Promise<Metadata> {
  const { country, subregion } = await params;
  const r = findRegion(country, subregion);
  if (!r) return {};
  return {
    title: `Best motorcycle roads in ${r.name} — Tarmoto`,
    description: r.description,
    alternates: {
      canonical: `/roads/best/${r.country}/${r.parent}/${r.slug}`,
    },
  };
}

export default async function BestRoadsSubRegionPage({
  params,
}: {
  params: Promise<{ country: string; region: string; subregion: string }>;
}) {
  const { country, region: parentSlug, subregion } = await params;
  const regionMeta = findRegion(country, subregion);
  const parentMeta = findRegion(country, parentSlug);
  const countryMeta = findCountry(country);
  if (
    !regionMeta ||
    !parentMeta ||
    !countryMeta ||
    regionMeta.parent !== parentSlug
  ) {
    notFound();
  }

  const payload = await fetchBestRoads(country, subregion, 10);
  if (!payload) notFound();

  const roads = payload.roads;
  const segmentIds = roads.map((r) => r.id).join(",");
  const pageUrl = `${siteUrl()}/roads/best/${country}/${parentSlug}/${subregion}`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-100">
      <nav className="mb-4 text-sm text-slate-400">
        <Link href="/roads/best" className="hover:text-white">
          Best roads
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/roads/best/${country}`} className="hover:text-white">
          {countryMeta.name}
        </Link>
        <span className="mx-2">/</span>
        <Link
          href={`/roads/best/${country}/${parentSlug}`}
          className="hover:text-white"
        >
          {parentMeta.name}
        </Link>
        <span className="mx-2">/</span>
        <span>{regionMeta.name}</span>
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Best motorcycle roads in {regionMeta.name}
        </h1>
        <p className="mt-3 max-w-3xl text-slate-300">
          {regionMeta.description}
        </p>
        {regionMeta.bestSeason && (
          <p className="mt-2 text-sm text-slate-500">
            Best season: {regionMeta.bestSeason}
          </p>
        )}
      </header>

      <section className="mb-8">
        <BestRoadsMap
          bbox={regionMeta.bbox}
          center={regionMeta.center}
          defaultZoom={regionMeta.defaultZoom}
          roads={roads}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-xl font-semibold">Ranked roads</h2>
        <BestRoadsList roads={roads} />
      </section>

      {roads.length > 0 && (
        <section className="mb-12 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold">
            Plan a trip with these roads
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Pre-load this list into your trip planner to build a multi-day ride
            around them.
          </p>
          <Link
            href={`/trip-planner?segments=${segmentIds}`}
            className="mt-4 inline-flex items-center rounded-lg bg-tarmoto-cyan px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-tarmoto-cyan/90 transition"
          >
            Plan a trip with these roads
          </Link>
        </section>
      )}

      <BestRoadsSchemaOrg
        regionName={regionMeta.name}
        countryName={countryMeta.name}
        countryCode={countryMeta.code}
        regionSlug={regionMeta.slug}
        parentSlug={parentSlug}
        pageUrl={pageUrl}
        description={regionMeta.description}
        roads={roads}
      />
    </main>
  );
}
```

- [ ] **Step 11.2: Commit**

```bash
git add "apps/companion/src/app/roads/best/[country]/[region]/[subregion]/page.tsx"
git commit -m "feat(companion): add best-roads sub-region page"
```

---

## Task 12: Full verification + PR

**Files:** none (verification only)

- [ ] **Step 12.1: Lint everything**

Run: `pnpm lint`
Expected: zero new lint errors. Fix inline if any surface.

- [ ] **Step 12.2: Build everything**

Run in order:

```bash
pnpm build:shared
pnpm generate:api
pnpm build:backend
pnpm --filter @tarmoto/backend test
pnpm build:companion
```

Expected: all clean.

Note: `build:companion` hits `API_BASE_SERVER` (default
`http://localhost:3000`) when rendering static params for region pages. If
the backend isn't running during build, Next will mark those pages dynamic
— acceptable for local. If it errors hard, run `pnpm dev:backend` in
another terminal before `pnpm build:companion`.

- [ ] **Step 12.3: Manual smoke test**

Preconditions: `pnpm db:up && pnpm db:migrate` with the database seeded
(the repo's existing seed covers Moravia, which intersects Beskydy).

Start the stack in two terminals:

```bash
pnpm dev:backend
pnpm dev:companion
```

Verify:

1. `curl 'http://localhost:3000/api/v1/roads/best?country=cz&region=beskydy'`
   → 200 with `{ region, roads: [...] }`.
2. `curl 'http://localhost:3000/api/v1/roads/best?country=cz&region=does-not-exist'`
   → 404.
3. Browse `http://localhost:3001/roads/best` — country hub renders.
4. Browse `http://localhost:3001/roads/best/cz` — Czech regions render.
5. Browse `http://localhost:3001/roads/best/cz/beskydy` — hero + map with
   rank markers + ranked list + CTA. `view-source:` contains two
   `<script type="application/ld+json">` blocks (ItemList + BreadcrumbList).
6. Browse `http://localhost:3001/roads/best/at/tyrol/alpine-passes` —
   sub-region page with correct breadcrumb.
7. Browse `http://localhost:3001/sitemap.xml` — contains `/roads/best`,
   `/roads/best/cz`, `/roads/best/cz/beskydy`, plus sub-region URLs.
8. Browse `http://localhost:3001/roads/best/xx/invalid` while signed out —
   renders the Next.js 404 page, not a login redirect.

- [ ] **Step 12.4: Open the PR**

Push the branch and open a PR. Title must be a conventional commit:

```
feat(backend,companion,shared): best-roads SEO pages (us-46)
```

PR body:

- Link to [#58](https://github.com/Studio81Labs/tarmoto/issues/58) and the
  design spec.
- Summarise each of the 7 acceptance criteria → how it was met.
- Call out deferred items (photos, functional trip-planner CTA) and note
  that follow-up issues will be filed after merge.
- Include the verification commands and manual-smoke checklist from Steps
  12.1-12.3.
