# OSM Road-Quality Seed + Confidence Blend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed `road_segments.quality_score` from OSM `smoothness`/`surface`/`highway` tags and blend it with rider data by confidence, so road quality is populated everywhere before any riders exist — with the estimate honestly labeled on road-detail surfaces.

**Architecture:** A pure `quality-seed.ts` derives an `osm_quality_seed` + `quality_source` per OSM way. The importer writes them on every import and seeds `quality_score` for rider-less segments. The rider aggregation SQL function `update_road_quality_for_segment` blends `quality_score = (rider_mean·n + seed·k)/(n+k)`. Two new DTO fields carry the provenance to mobile + companion road-detail screens.

**Tech Stack:** NestJS 11 + TypeORM (raw SQL migrations, PL/pgSQL), PostgreSQL 16 + PostGIS, `@tarmoto/shared` const-tuple enums, OpenAPI-generated client types, React Native (mobile), Next.js (companion), Jest.

## Global Constraints

- **`k` (prior weight) = 4.** Source of truth is the SQL literal in `update_road_quality_for_segment`; `QUALITY_SEED_PRIOR_WEIGHT = 4` in `quality-seed.ts` mirrors it for the TS blend reference/tests. Keep them in sync (cross-referenced by comment).
- **`quality_score` scale is `[1,5]`;** `NULL` = neutral/no data. `confidence` is `0–100`. `reading_count` is the blend's `n`.
- **`quality_source` values:** `osm_smoothness` | `osm_surface` | `osm_highway` (never `reading` — there is no sticky flag; the blend gate is `reading_count`).
- **Pre-production / test phase:** breaking changes acceptable; no gradual rollout. `road_segments` is empty in prod (road subsystem dormant, `osmImportConfig.enabled` false) — no backfill.
- **Live aggregation fn body** is the one from migration `1788000000000-AddSurfaceFromReading` (it includes the `surface_from_reading` maintenance). Any redeclare starts from that body.
- **Backend `*.e2e-spec.ts` do not run in CI** (per repo convention) — SQL-function behavior is a manual pre-release gate; still write the e2e spec.
- **Commit conventions:** conventional commits, lowercase subject, scope required (`backend` / `shared` / `mobile` / `companion` / `openapi`). End commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/backend-road-quality-osm-seed` (already created; spec committed).

## File Structure

- `packages/shared/src/constants.ts` — **modify**: add `QUALITY_SOURCES` + `QualitySource`.
- `apps/backend/src/modules/roads/osm-import/quality-seed.ts` — **create**: pure seed derivation + `QUALITY_SEED_PRIOR_WEIGHT`.
- `apps/backend/src/modules/roads/osm-import/quality-seed.spec.ts` — **create**: exhaustive unit tests.
- `apps/backend/src/modules/roads/osm-import/segment-rows.ts` — **modify**: `RoadSegmentRow` + `waySegmentRows` carry the seed.
- `apps/backend/src/modules/roads/osm-import/segment-rows.spec.ts` — **modify**.
- `apps/backend/src/entities/road-segment.entity.ts` — **modify**: two `@Column`s.
- `apps/backend/src/migrations/1795000000000-AddRoadQualitySeed.ts` — **create**: columns + blended fn.
- `apps/backend/src/modules/roads/osm-import/osm-import.service.ts` — **modify**: upsert seed refresh + `quality_score` gate + carry-over.
- `apps/backend/src/modules/roads/osm-import/osm-import.service.spec.ts` — **modify**: conflict-clause assertions.
- `apps/backend/test/road-quality-seed.e2e-spec.ts` — **create**: real-PG blend gate.
- `apps/backend/src/modules/roads/dto/road-segment.dto.ts` — **modify**: two fields on `RoadSegmentDto`.
- `apps/backend/src/modules/roads/roads.service.ts` — **modify**: `findNearby` + `findById` SELECT + map.
- `apps/backend/src/modules/roads/roads.service.spec.ts` — **modify**.
- `apps/mobile/src/theme/index.ts` — **modify**: `qualityProvenanceLabel` helper.
- `apps/mobile/src/theme/__tests__/` or sibling `.test.ts` — **create/modify**: helper test.
- `apps/mobile/src/screens/RoadPreviewScreen.tsx` — **modify**: estimated badge + confidence-bug fix.
- `apps/companion/src/lib/utils.ts` — **modify**: `qualityProvenanceLabel` helper.
- `apps/companion/src/lib/utils.test.ts` (or sibling) — **modify/create**.
- `apps/companion/src/components/RoadPreviewCard.tsx` — **modify**: estimated treatment.

---

### Task 1: Shared `QualitySource` enum

**Files:**

- Modify: `packages/shared/src/constants.ts` (after the `PLAN_SOURCES` block, ~line 114)
- Test: `packages/shared/src/constants.spec.ts` (create if absent; otherwise append)

**Interfaces:**

- Produces: `QUALITY_SOURCES: readonly ['osm_smoothness','osm_surface','osm_highway']`, `type QualitySource = 'osm_smoothness' | 'osm_surface' | 'osm_highway'`. Auto-exported via `packages/shared/src/index.ts` (`export * from "./constants"`).

- [ ] **Step 1: Add the enum** to `packages/shared/src/constants.ts`, mirroring the `PLAN_SOURCES` pattern:

```typescript
/**
 * Provenance of a road segment's OSM-derived quality seed (design 2026-07-15).
 * The signal the seed was derived from, in precedence order. Never includes a
 * "reading" value — rider contribution is conveyed by `reading_count`, not this.
 */
export const QUALITY_SOURCES = [
  "osm_smoothness",
  "osm_surface",
  "osm_highway",
] as const;

export type QualitySource = (typeof QUALITY_SOURCES)[number];
```

- [ ] **Step 2: Write the test** in `packages/shared/src/constants.spec.ts`:

```typescript
import { QUALITY_SOURCES, type QualitySource } from "./constants";

describe("QUALITY_SOURCES", () => {
  it("lists the three OSM signals in precedence order and never 'reading'", () => {
    expect(QUALITY_SOURCES).toEqual([
      "osm_smoothness",
      "osm_surface",
      "osm_highway",
    ]);
    expect(QUALITY_SOURCES as readonly string[]).not.toContain("reading");
  });

  it("QualitySource is the union of the tuple", () => {
    const s: QualitySource = "osm_surface";
    expect(QUALITY_SOURCES).toContain(s);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @tarmoto/shared test -- constants`
Expected: PASS.

- [ ] **Step 4: Build shared** (downstream backend/clients import the built package)

Run: `pnpm --filter @tarmoto/shared build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/constants.spec.ts
git commit -m "feat(shared): add QualitySource enum for road-quality seed provenance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Seed derivation module (`quality-seed.ts`)

**Files:**

- Create: `apps/backend/src/modules/roads/osm-import/quality-seed.ts`
- Test: `apps/backend/src/modules/roads/osm-import/quality-seed.spec.ts`

**Interfaces:**

- Consumes: `OsmTags` from `./osm-tags.js`; `QualitySource` from `@tarmoto/shared`.
- Produces: `QUALITY_SEED_PRIOR_WEIGHT: 4`; `interface QualitySeed { score: number | null; source: QualitySource | null }`; `qualitySeedFromTags(tags: OsmTags): QualitySeed`.

- [ ] **Step 1: Write the failing test** `quality-seed.spec.ts`:

```typescript
import {
  qualitySeedFromTags,
  QUALITY_SEED_PRIOR_WEIGHT,
} from "./quality-seed.js";

describe("qualitySeedFromTags", () => {
  it("maps smoothness (inverse of ADR-0005), clamping worse-than-scale tiers to 1", () => {
    expect(qualitySeedFromTags({ smoothness: "excellent" })).toEqual({
      score: 5,
      source: "osm_smoothness",
    });
    expect(qualitySeedFromTags({ smoothness: "good" })).toEqual({
      score: 4,
      source: "osm_smoothness",
    });
    expect(qualitySeedFromTags({ smoothness: "intermediate" })).toEqual({
      score: 3,
      source: "osm_smoothness",
    });
    expect(qualitySeedFromTags({ smoothness: "bad" })).toEqual({
      score: 2,
      source: "osm_smoothness",
    });
    for (const s of ["very_bad", "horrible", "very_horrible", "impassable"]) {
      expect(qualitySeedFromTags({ smoothness: s })).toEqual({
        score: 1,
        source: "osm_smoothness",
      });
    }
  });

  it("falls back to surface when smoothness is absent/unknown", () => {
    expect(qualitySeedFromTags({ surface: "asphalt" })).toEqual({
      score: 4,
      source: "osm_surface",
    });
    expect(qualitySeedFromTags({ surface: "compacted" })).toEqual({
      score: 3,
      source: "osm_surface",
    });
    expect(qualitySeedFromTags({ surface: "gravel" })).toEqual({
      score: 2,
      source: "osm_surface",
    });
    expect(qualitySeedFromTags({ surface: "mud" })).toEqual({
      score: 1,
      source: "osm_surface",
    });
    // Unknown smoothness value → not matched → falls through to surface.
    expect(
      qualitySeedFromTags({ smoothness: "weird", surface: "asphalt" }),
    ).toEqual({ score: 4, source: "osm_surface" });
  });

  it("falls back to highway class when smoothness and surface are absent (+_link normalised)", () => {
    expect(qualitySeedFromTags({ highway: "motorway" })).toEqual({
      score: 4,
      source: "osm_highway",
    });
    expect(qualitySeedFromTags({ highway: "secondary_link" })).toEqual({
      score: 4,
      source: "osm_highway",
    });
    expect(qualitySeedFromTags({ highway: "residential" })).toEqual({
      score: 3,
      source: "osm_highway",
    });
    expect(qualitySeedFromTags({ highway: "track" })).toEqual({
      score: 2,
      source: "osm_highway",
    });
  });

  it("precedence: smoothness beats surface beats highway", () => {
    expect(
      qualitySeedFromTags({
        smoothness: "bad",
        surface: "asphalt",
        highway: "motorway",
      }),
    ).toEqual({ score: 2, source: "osm_smoothness" });
    expect(
      qualitySeedFromTags({ surface: "gravel", highway: "motorway" }),
    ).toEqual({ score: 2, source: "osm_surface" });
  });

  it("returns {null,null} when nothing matches", () => {
    expect(qualitySeedFromTags({})).toEqual({ score: null, source: null });
    expect(qualitySeedFromTags({ highway: "proposed" })).toEqual({
      score: null,
      source: null,
    });
  });

  it("exports the prior weight k=4 matching the SQL literal", () => {
    expect(QUALITY_SEED_PRIOR_WEIGHT).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- quality-seed`
Expected: FAIL — "Cannot find module './quality-seed.js'".

- [ ] **Step 3: Implement** `quality-seed.ts`:

```typescript
import type { QualitySource } from "@tarmoto/shared";
import type { OsmTags } from "./osm-tags.js";

/**
 * Prior weight `k` for the OSM-seed ↔ rider-data confidence blend
 * (design 2026-07-15): `effective = (rider_mean·n + seed·k)/(n+k)`. ~4 rider
 * reports reach a 50/50 blend. SOURCE OF TRUTH is the SQL literal in
 * `update_road_quality_for_segment` (migration 1795000000000); this mirror
 * exists for the TS blend reference + tests and MUST stay in sync with it.
 */
export const QUALITY_SEED_PRIOR_WEIGHT = 4;

export interface QualitySeed {
  /** Seeded quality in [1,5], or null when no OSM signal matched. */
  score: number | null;
  /** Which OSM signal produced `score`, or null. */
  source: QualitySource | null;
}

/** OSM `smoothness` → [1,5] (inverse of ADR-0005; worse tiers clamp to 1). */
const SMOOTHNESS_SEED: Readonly<Record<string, number>> = {
  excellent: 5,
  good: 4,
  intermediate: 3,
  bad: 2,
  very_bad: 1,
  horrible: 1,
  very_horrible: 1,
  impassable: 1,
};

/** OSM `surface` → [1,5] (material as a quality proxy). */
const SURFACE_SEED: Readonly<Record<string, number>> = {
  asphalt: 4,
  concrete: 4,
  "concrete:plates": 4,
  paving_stones: 4,
  chipseal: 4,
  sett: 3,
  cobblestone: 3,
  compacted: 3,
  fine_gravel: 3,
  metal: 3,
  wood: 3,
  gravel: 2,
  pebblestone: 2,
  ground: 2,
  dirt: 2,
  earth: 2,
  unpaved: 2,
  sand: 1,
  mud: 1,
  grass: 1,
  clay: 1,
};

/** OSM `highway` class → [1,5] (weak proxy; `_link` normalised to its base). */
function highwaySeed(highway: string | undefined): number | null {
  if (!highway) return null;
  const base = highway.replace(/_link$/, "");
  switch (base) {
    case "motorway":
    case "trunk":
    case "primary":
    case "secondary":
      return 4;
    case "tertiary":
    case "unclassified":
    case "residential":
    case "living_street":
    case "service":
    case "road":
      return 3;
    case "track":
      return 2;
    default:
      return null;
  }
}

/**
 * Derive a road segment's OSM quality seed from a way's tags. Precedence:
 * `smoothness` → `surface` → `highway`, first hit wins; `{null,null}` when none
 * match. Pure; the DB blend + the importer decide how the seed coexists with
 * rider data (design 2026-07-15).
 */
export function qualitySeedFromTags(tags: OsmTags): QualitySeed {
  const sm = tags.smoothness ? SMOOTHNESS_SEED[tags.smoothness] : undefined;
  if (sm !== undefined) return { score: sm, source: "osm_smoothness" };

  const su = tags.surface ? SURFACE_SEED[tags.surface] : undefined;
  if (su !== undefined) return { score: su, source: "osm_surface" };

  const hw = highwaySeed(tags.highway);
  if (hw !== null) return { score: hw, source: "osm_highway" };

  return { score: null, source: null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @tarmoto/backend test -- quality-seed`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/roads/osm-import/quality-seed.ts apps/backend/src/modules/roads/osm-import/quality-seed.spec.ts
git commit -m "feat(backend): OSM road-quality seed derivation (smoothness/surface/highway)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Carry the seed into `RoadSegmentRow`

**Files:**

- Modify: `apps/backend/src/modules/roads/osm-import/segment-rows.ts:35-70`
- Test: `apps/backend/src/modules/roads/osm-import/segment-rows.spec.ts`

**Interfaces:**

- Consumes: `qualitySeedFromTags` (Task 2).
- Produces: `RoadSegmentRow` gains `osm_quality_seed: number | null`, `quality_source: QualitySource | null`, `quality_score: number | null` (= the seed, so a fresh INSERT seeds the effective score). Later tasks (upsert) rely on all three keys being present on every row.

- [ ] **Step 1: Add the failing test** to `segment-rows.spec.ts` (append a describe):

```typescript
import { waySegmentRows } from "./segment-rows.js";

describe("waySegmentRows quality seed", () => {
  const coords = [
    { lng: 0, lat: 0 },
    { lng: 0.01, lat: 0 },
  ];

  it("stamps osm_quality_seed + quality_source + quality_score from tags", () => {
    const rows = waySegmentRows({
      id: 42,
      tags: { highway: "primary", smoothness: "good" },
      coords,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.osm_quality_seed).toBe(4);
      expect(r.quality_source).toBe("osm_smoothness");
      // The effective score is seeded on insert (= the OSM seed).
      expect(r.quality_score).toBe(4);
    }
  });

  it("leaves the seed null when no OSM signal matches (highway=proposed is non-drivable → no rows, so use a drivable no-signal case)", () => {
    const rows = waySegmentRows({
      id: 7,
      tags: { highway: "service" },
      coords,
    });
    // service → highway-class seed 3
    expect(rows[0]?.osm_quality_seed).toBe(3);
    expect(rows[0]?.quality_source).toBe("osm_highway");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- segment-rows`
Expected: FAIL — `osm_quality_seed` undefined on the row.

- [ ] **Step 3: Modify `segment-rows.ts`.** Add the import and the three fields.

Change the imports block (top of file) to add the seed import:

```typescript
import {
  type OsmTags,
  isDrivableHighway,
  roadFieldsFromTags,
} from "./osm-tags.js";
import { qualitySeedFromTags } from "./quality-seed.js";
import type { QualitySource } from "@tarmoto/shared";
```

Extend the `RoadSegmentRow` interface (currently ends at `surface_type: SurfaceType;`):

```typescript
/** A `road_segments` row built from one ~100 m slice of an OSM way. */
export interface RoadSegmentRow {
  osm_way_id: string;
  segment_index: number;
  geom: GeoJSON.LineString;
  length_m: number;
  curviness_score: number;
  road_name: string | null;
  road_number: string | null;
  surface_type: SurfaceType;
  /** OSM-derived quality prior [1,5], refreshed every import (design 2026-07-15). */
  osm_quality_seed: number | null;
  /** Which OSM signal produced `osm_quality_seed`. */
  quality_source: QualitySource | null;
  /** Effective quality — seeded to `osm_quality_seed` on INSERT so a rider-less
   *  segment shows quality immediately; the DB blend + upsert gate own it after. */
  quality_score: number | null;
}
```

Modify `waySegmentRows` — compute the seed once per way and spread it:

```typescript
export function waySegmentRows(way: OsmWay): RoadSegmentRow[] {
  if (!isDrivableHighway(way.tags)) return [];
  const fields = roadFieldsFromTags(way.tags);
  const seed = qualitySeedFromTags(way.tags);
  const osm_way_id = String(way.id);
  return segmentWay(way.coords)
    .filter((seg) => seg.length_m > 0)
    .map((seg, index) => ({
      osm_way_id,
      segment_index: index,
      geom: {
        type: "LineString" as const,
        coordinates: seg.coords.map((p) => [p.lng, p.lat]),
      },
      length_m: seg.length_m,
      curviness_score: seg.curviness_score,
      ...fields,
      osm_quality_seed: seed.score,
      quality_source: seed.source,
      quality_score: seed.score,
    }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @tarmoto/backend test -- segment-rows`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/roads/osm-import/segment-rows.ts apps/backend/src/modules/roads/osm-import/segment-rows.spec.ts
git commit -m "feat(backend): carry OSM quality seed on road segment rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Entity columns + migration (columns + blended aggregation fn)

**Files:**

- Modify: `apps/backend/src/entities/road-segment.entity.ts` (after `quality_score`, ~line 70)
- Create: `apps/backend/src/migrations/1795000000000-AddRoadQualitySeed.ts`
- Test: `apps/backend/test/road-quality-seed.e2e-spec.ts` (real-PG manual gate)

**Interfaces:**

- Produces: columns `road_segments.osm_quality_seed FLOAT NULL`, `road_segments.quality_source VARCHAR(20) NULL`; `update_road_quality_for_segment` now writes the k=4 blend into `quality_score`.

- [ ] **Step 1: Add the entity columns.** In `road-segment.entity.ts`, immediately after the `quality_score` column (before `surface_type`):

```typescript
  @Column({ type: 'float', nullable: true })
  quality_score!: number | null;

  /**
   * OSM-derived quality prior [1,5] (design 2026-07-15). Refreshed from tags on
   * every import; blended with rider data into `quality_score` by
   * `update_road_quality_for_segment`. Never owned away by riders.
   */
  @Column({ type: 'float', nullable: true })
  osm_quality_seed!: number | null;

  /** Which OSM signal produced `osm_quality_seed` (provenance for labeling). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  quality_source!: string | null;
```

- [ ] **Step 2: Create the migration** `1795000000000-AddRoadQualitySeed.ts`. `up()` adds the columns, then `CREATE OR REPLACE`s the aggregation fn (copied from `1788000000000`'s body, with ONLY the `quality_score` assignment changed to the blend). `down()` drops the columns and restores `1788000000000`'s exact body.

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Design 2026-07-15 — OSM road-quality seed + confidence blend.
 *
 * Adds `osm_quality_seed` (OSM prior [1,5]) + `quality_source` provenance, and
 * re-declares `update_road_quality_for_segment` so the aggregated `quality_score`
 * is a Bayesian blend of the rider mean and the OSM seed weighted by rider count:
 *   quality_score = (rider_mean·n + seed·k) / (n + k),  k = 4.
 * `n = 0` or no valid readings → pure seed; seed NULL → pure rider mean.
 *
 * The function body is otherwise identical to 1788000000000-AddSurfaceFromReading
 * (the live version, which maintains `surface_from_reading`). `road_segments` is
 * empty in prod (road subsystem dormant), so no backfill is needed.
 */
export class AddRoadQualitySeed1795000000000 implements MigrationInterface {
  name = "AddRoadQualitySeed1795000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE road_segments
        ADD COLUMN IF NOT EXISTS osm_quality_seed FLOAT,
        ADD COLUMN IF NOT EXISTS quality_source VARCHAR(20);
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality_for_segment(p_segment_id UUID)
      RETURNS INT
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_filtered_count INT := 0;
      BEGIN
        WITH scored AS (
          SELECT
            sr.id,
            sr.user_id,
            sr.recorded_at,
            CASE sr.classification
              WHEN 'excellent' THEN 5.0
              WHEN 'good'      THEN 4.0
              WHEN 'fair'      THEN 3.0
              WHEN 'poor'      THEN 2.0
              WHEN 'very_poor' THEN 1.0
            END AS quality_score
          FROM surface_readings sr
          WHERE sr.road_segment_id = p_segment_id
        ),
        valid AS (
          SELECT * FROM scored WHERE quality_score IS NOT NULL
        ),
        stats AS (
          SELECT
            COUNT(*)::int        AS total_count,
            AVG(quality_score)   AS mean_q,
            stddev_samp(quality_score) AS std_q
          FROM valid
        ),
        flagged AS (
          SELECT
            v.id,
            v.user_id,
            v.recorded_at,
            v.quality_score,
            CASE
              WHEN s.total_count < 3 THEN false
              WHEN s.std_q IS NULL OR s.std_q = 0 THEN false
              WHEN ABS(v.quality_score - s.mean_q) > 2 * s.std_q THEN true
              ELSE false
            END AS is_outlier
          FROM valid v
          CROSS JOIN stats s
        ),
        kept AS (
          SELECT
            quality_score,
            user_id,
            CASE
              WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
              WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
              WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
              ELSE 0.2
            END AS recency_weight
          FROM flagged
          WHERE NOT is_outlier
        ),
        agg AS (
          SELECT
            SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
            COUNT(*)::int                AS reading_count,
            COUNT(DISTINCT user_id)::int AS unique_rider_count
          FROM kept
        ),
        fc AS (
          SELECT COUNT(*)::int AS filtered_count FROM flagged WHERE is_outlier
        ),
        surface_mode AS (
          SELECT surface_type
          FROM surface_readings
          WHERE road_segment_id = p_segment_id
            AND surface_type IS NOT NULL
          GROUP BY surface_type
          ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC
          LIMIT 1
        )
        UPDATE road_segments rs
        SET
          -- Blend the rider mean with the OSM seed by rider count (k = 4).
          -- No valid readings → pure seed; no seed → pure rider mean.
          quality_score = CASE
            WHEN agg.reading_count = 0 OR agg.quality_score IS NULL
              THEN rs.osm_quality_seed
            WHEN rs.osm_quality_seed IS NULL
              THEN agg.quality_score
            ELSE (agg.quality_score * agg.reading_count + rs.osm_quality_seed * 4)
                 / (agg.reading_count + 4)
          END,
          reading_count = agg.reading_count,
          confidence = CASE
            WHEN agg.reading_count >= 20 AND agg.unique_rider_count >= 5 THEN 100
            WHEN agg.reading_count >= 10 THEN 90
            WHEN agg.reading_count >= 5  THEN 70
            WHEN agg.reading_count >= 3  THEN 50
            WHEN agg.reading_count >= 1  THEN 20
            ELSE 0
          END,
          surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
          surface_from_reading = rs.surface_from_reading
            OR (SELECT surface_type FROM surface_mode) IS NOT NULL,
          last_filtered_count = fc.filtered_count,
          last_updated = NOW()
        FROM agg, fc
        WHERE rs.id = p_segment_id
        RETURNING rs.last_filtered_count INTO v_filtered_count;

        RETURN COALESCE(v_filtered_count, 0);
      END;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the 1788000000000 body (rider-only quality_score, no blend).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_road_quality_for_segment(p_segment_id UUID)
      RETURNS INT
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_filtered_count INT := 0;
      BEGIN
        WITH scored AS (
          SELECT
            sr.id, sr.user_id, sr.recorded_at,
            CASE sr.classification
              WHEN 'excellent' THEN 5.0 WHEN 'good' THEN 4.0 WHEN 'fair' THEN 3.0
              WHEN 'poor' THEN 2.0 WHEN 'very_poor' THEN 1.0
            END AS quality_score
          FROM surface_readings sr WHERE sr.road_segment_id = p_segment_id
        ),
        valid AS (SELECT * FROM scored WHERE quality_score IS NOT NULL),
        stats AS (
          SELECT COUNT(*)::int AS total_count, AVG(quality_score) AS mean_q,
                 stddev_samp(quality_score) AS std_q
          FROM valid
        ),
        flagged AS (
          SELECT v.id, v.user_id, v.recorded_at, v.quality_score,
            CASE
              WHEN s.total_count < 3 THEN false
              WHEN s.std_q IS NULL OR s.std_q = 0 THEN false
              WHEN ABS(v.quality_score - s.mean_q) > 2 * s.std_q THEN true
              ELSE false
            END AS is_outlier
          FROM valid v CROSS JOIN stats s
        ),
        kept AS (
          SELECT quality_score, user_id,
            CASE
              WHEN recorded_at >= NOW() - INTERVAL '30 days'  THEN 1.0
              WHEN recorded_at >= NOW() - INTERVAL '90 days'  THEN 0.7
              WHEN recorded_at >= NOW() - INTERVAL '180 days' THEN 0.4
              ELSE 0.2
            END AS recency_weight
          FROM flagged WHERE NOT is_outlier
        ),
        agg AS (
          SELECT SUM(quality_score * recency_weight) / NULLIF(SUM(recency_weight), 0) AS quality_score,
                 COUNT(*)::int AS reading_count, COUNT(DISTINCT user_id)::int AS unique_rider_count
          FROM kept
        ),
        fc AS (SELECT COUNT(*)::int AS filtered_count FROM flagged WHERE is_outlier),
        surface_mode AS (
          SELECT surface_type FROM surface_readings
          WHERE road_segment_id = p_segment_id AND surface_type IS NOT NULL
          GROUP BY surface_type
          ORDER BY COUNT(*) DESC, MAX(recorded_at) DESC, surface_type ASC LIMIT 1
        )
        UPDATE road_segments rs
        SET
          quality_score = agg.quality_score,
          reading_count = agg.reading_count,
          confidence = CASE
            WHEN agg.reading_count >= 20 AND agg.unique_rider_count >= 5 THEN 100
            WHEN agg.reading_count >= 10 THEN 90
            WHEN agg.reading_count >= 5  THEN 70
            WHEN agg.reading_count >= 3  THEN 50
            WHEN agg.reading_count >= 1  THEN 20
            ELSE 0
          END,
          surface_type = COALESCE((SELECT surface_type FROM surface_mode), rs.surface_type),
          surface_from_reading = rs.surface_from_reading
            OR (SELECT surface_type FROM surface_mode) IS NOT NULL,
          last_filtered_count = fc.filtered_count,
          last_updated = NOW()
        FROM agg, fc
        WHERE rs.id = p_segment_id
        RETURNING rs.last_filtered_count INTO v_filtered_count;
        RETURN COALESCE(v_filtered_count, 0);
      END;
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE road_segments
        DROP COLUMN IF EXISTS quality_source,
        DROP COLUMN IF EXISTS osm_quality_seed;
    `);
  }
}
```

- [ ] **Step 3: Register the migration** if the datasource uses an explicit list. Check `apps/backend/src/data-source.ts` / the migrations glob — the repo auto-globs `migrations/*.ts`, so no manual registration is needed. Confirm with:

Run: `rg -n "migrations" apps/backend/src/data-source.ts`
Expected: a glob like `migrations: ['dist/migrations/*.js']` (auto-discovered — no edit).

- [ ] **Step 4: Build + run the migration against a local PG** (design uses real PG; `pnpm db:up` must be running):

Run: `pnpm --filter @tarmoto/backend build && pnpm db:migrate`
Expected: `AddRoadQualitySeed1795000000000` runs; exits 0.

- [ ] **Step 5: Write the e2e gate** `apps/backend/test/road-quality-seed.e2e-spec.ts` (real PG; not run in CI, manual gate). It seeds a segment, inserts readings, calls the fn, and asserts the blend:

```typescript
import { DataSource } from "typeorm";
import { AppDataSource } from "../src/data-source.js";

// Manual pre-release gate (real PostgreSQL). Run: pnpm --filter @tarmoto/backend test:e2e -- road-quality-seed
describe("road-quality seed blend (real PG)", () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = await AppDataSource.initialize();
  });
  afterAll(async () => {
    await ds.destroy();
  });

  async function makeSegment(seed: number | null): Promise<string> {
    const [{ id }] = await ds.query(
      `INSERT INTO road_segments (geom, length_m, osm_quality_seed, quality_source, quality_score)
       VALUES (ST_SetSRID(ST_MakeLine(ST_MakePoint(0,0), ST_MakePoint(0.01,0)),4326), 100, $1, 'osm_highway', $1)
       RETURNING id`,
      [seed],
    );
    return id as string;
  }
  async function addReading(
    segId: string,
    classification: string,
  ): Promise<void> {
    await ds.query(
      `INSERT INTO surface_readings (road_segment_id, user_id, classification, recorded_at)
       VALUES ($1, gen_random_uuid(), $2, NOW())`,
      [segId, classification],
    );
  }

  it("n=0 → quality_score equals the seed", async () => {
    const id = await makeSegment(4);
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const [row] = await ds.query(
      `SELECT quality_score FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(row.quality_score)).toBeCloseTo(4, 5);
  });

  it("blends toward the rider mean by count (seed=4, k=4, one very_poor reading → 3.6)", async () => {
    const id = await makeSegment(4);
    await addReading(id, "poor"); // 2.0
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const [row] = await ds.query(
      `SELECT quality_score, reading_count FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(row.reading_count)).toBe(1);
    expect(Number(row.quality_score)).toBeCloseTo((2 * 1 + 4 * 4) / 5, 4); // 3.6
  });

  it("null seed → pure rider mean", async () => {
    const id = await makeSegment(null);
    await addReading(id, "good"); // 4.0
    await ds.query(`SELECT update_road_quality_for_segment($1)`, [id]);
    const [row] = await ds.query(
      `SELECT quality_score FROM road_segments WHERE id=$1`,
      [id],
    );
    expect(Number(row.quality_score)).toBeCloseTo(4, 4);
  });
});
```

- [ ] **Step 6: Run the e2e gate** (real PG):

Run: `pnpm --filter @tarmoto/backend test:e2e -- road-quality-seed`
Expected: PASS (3 tests). If `test:e2e` script differs, use the repo's e2e runner (`rg '"test:e2e"' apps/backend/package.json`).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/entities/road-segment.entity.ts apps/backend/src/migrations/1795000000000-AddRoadQualitySeed.ts apps/backend/test/road-quality-seed.e2e-spec.ts
git commit -m "feat(backend): add road quality seed columns + blend aggregation fn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Importer upsert — refresh seed + gate `quality_score`

**Files:**

- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.service.ts:18-146` (constants + conflict builder + carry-over)
- Test: `apps/backend/src/modules/roads/osm-import/osm-import.service.spec.ts:50-62` (extend clause assertions)

**Interfaces:**

- Consumes: `RoadSegmentRow` with `osm_quality_seed`/`quality_source`/`quality_score` (Task 3); the new columns (Task 4).
- Produces: `ROAD_SEGMENT_ON_CONFLICT` refreshes the two seed columns every import and gates `quality_score` on `reading_count = 0`.

- [ ] **Step 1: Extend the failing test.** In `osm-import.service.spec.ts`, add assertions after the existing surface-clause test:

```typescript
it("refreshes the OSM quality seed + source every import, and seeds quality_score only for rider-less segments", () => {
  expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
    '"osm_quality_seed" = EXCLUDED."osm_quality_seed"',
  );
  expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
    '"quality_source" = EXCLUDED."quality_source"',
  );
  expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
    '"quality_score" = CASE WHEN "road_segments"."reading_count" = 0 ' +
      'THEN EXCLUDED."osm_quality_seed" ELSE "road_segments"."quality_score" END',
  );
  // A changed seed on a rider-less segment must trigger the update.
  expect(ROAD_SEGMENT_ON_CONFLICT).toContain(
    '("road_segments"."reading_count" = 0 AND ' +
      '"road_segments"."quality_score" IS DISTINCT FROM EXCLUDED."osm_quality_seed")',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.service`
Expected: FAIL — clause missing the new fragments.

- [ ] **Step 3: Modify the constants + builder in `osm-import.service.ts`.**

Add the two seed columns to `OSM_REFRESH_COLUMNS` (they are OSM-owned, refreshed verbatim every import) and update its comment to note `quality_score` is now seeded (no longer "never carried"):

```typescript
/**
 * OSM-owned columns refreshed verbatim from the incoming snapshot on every
 * conflict. Excludes the rider-derived columns (`confidence`, `reading_count`)
 * and the blended `quality_score` (gated separately below). `surface_type` and
 * `quality_score` are handled with CASE gates further down.
 */
const OSM_REFRESH_COLUMNS = [
  "geom",
  "length_m",
  "curviness_score",
  "road_name",
  "road_number",
  "osm_quality_seed",
  "quality_source",
];
```

In `buildOnConflictClause()`, add the `quality_score` gate to the `set` array (after the `surface_type` CASE) and its change condition to the `changed` array (after the surface change condition). The `OSM_OWNS_QUALITY_SEED` gate mirrors surface:

```typescript
/** True iff no rider has contributed to this segment, so the OSM seed is still
 *  the effective quality and may be (re)seeded. The blend (migration
 *  1795000000000) owns quality_score once readings exist. */
const OSM_OWNS_QUALITY = `"${TABLE}"."reading_count" = 0`;

function buildOnConflictClause(): string {
  const set = [
    ...OSM_REFRESH_COLUMNS.map((c) => `"${c}" = EXCLUDED."${c}"`),
    `"surface_type" = CASE WHEN ${OSM_OWNS_SURFACE} ` +
      `THEN EXCLUDED."surface_type" ELSE "${TABLE}"."surface_type" END`,
    `"quality_score" = CASE WHEN ${OSM_OWNS_QUALITY} ` +
      `THEN EXCLUDED."osm_quality_seed" ELSE "${TABLE}"."quality_score" END`,
    ...GEOM_DERIVED_COLUMNS.map(
      (c) =>
        `"${c}" = CASE WHEN ${GEOM_CHANGED} THEN NULL ELSE "${TABLE}"."${c}" END`,
    ),
  ];
  const changed = [
    GEOM_CHANGED,
    ...OSM_REFRESH_COLUMNS.filter((c) => c !== "geom").map(
      (c) => `"${TABLE}"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`,
    ),
    `(${OSM_OWNS_SURFACE} AND ` +
      `"${TABLE}"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")`,
    `(${OSM_OWNS_QUALITY} AND ` +
      `"${TABLE}"."quality_score" IS DISTINCT FROM EXCLUDED."osm_quality_seed")`,
  ];
  const target = CONFLICT_COLUMNS.map((c) => `"${c}"`).join(", ");
  return (
    `( ${target} ) WHERE "deactivated_at" IS NULL ` +
    `DO UPDATE SET ${set.join(", ")} WHERE ${changed.join(" OR ")}`
  );
}
```

Update `CARRY_OVER_UPDATE` so a split/merge carry-over also refreshes the seed + source and re-seeds `quality_score` for rider-less segments. Change its doc comment's param list and the SQL (adds `$10 osm_quality_seed`, `$11 quality_source`):

```typescript
/* … Params: $1 osm_way_id, $2 segment_index, $3 geojson, $4 length_m,
   $5 curviness_score, $6 road_name, $7 road_number, $8 surface_type, $9 id,
   $10 osm_quality_seed, $11 quality_source. */
const CARRY_OVER_UPDATE = `
  UPDATE ${TABLE} SET
    osm_way_id = $1,
    segment_index = $2,
    geom = ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
    length_m = $4,
    curviness_score = $5,
    road_name = $6,
    road_number = $7,
    surface_type = CASE WHEN ${OSM_OWNS_SURFACE}
      THEN $8 ELSE "${TABLE}"."surface_type" END,
    osm_quality_seed = $10,
    quality_source = $11,
    quality_score = CASE WHEN ${OSM_OWNS_QUALITY}
      THEN $10 ELSE "${TABLE}"."quality_score" END,
    elevation_min = NULL,
    elevation_max = NULL,
    elevation_profile = NULL,
    deactivated_at = NULL,
    last_updated = NOW()
  WHERE id = $9
`;
```

Update the carry-over param binding (the array at ~lines 419-429) to append the two params:

```typescript
        row.osm_way_id,
        row.segment_index,
        JSON.stringify(row.geom),
        row.length_m,
        row.curviness_score,
        row.road_name,
        row.road_number,
        row.surface_type,
        c.existingId,
        row.osm_quality_seed,
        row.quality_source,
```

- [ ] **Step 4: Run to verify the clause tests pass**

Run: `pnpm --filter @tarmoto/backend test -- osm-import.service`
Expected: PASS (existing + new assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/roads/osm-import/osm-import.service.ts apps/backend/src/modules/roads/osm-import/osm-import.service.spec.ts
git commit -m "feat(backend): importer refreshes quality seed + seeds quality_score for rider-less segments

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Contract — DTO fields + mappers + OpenAPI regen

**Files:**

- Modify: `apps/backend/src/modules/roads/dto/road-segment.dto.ts:8-44` (base `RoadSegmentDto`)
- Modify: `apps/backend/src/modules/roads/roads.service.ts` (`findNearby` 299-350, `findById` 364-398 + 603-637)
- Modify: `apps/backend/src/modules/roads/roads.service.spec.ts`
- Regenerate: `packages/openapi-client/src/generated/schema.d.ts` (via `pnpm openapi:gen`)

**Interfaces:**

- Produces: `RoadSegmentDto` (and, by inheritance, `RoadSegmentDetailDto`) gains `quality_source: QualitySource | null` and `osm_quality_seed: number | null`. Mobile `Schemas["RoadSegmentDto"]` / companion `components["schemas"]["RoadSegmentDto"]` pick these up after regen.

- [ ] **Step 1: Add the DTO fields.** In `road-segment.dto.ts`, add the import and two fields on `RoadSegmentDto` (after `surface_type`):

```typescript
import {
  SURFACE_TYPES,
  QUALITY_SOURCES,
  type SurfaceType,
  type QualitySource,
} from "@tarmoto/shared";
```

```typescript
  @ApiProperty({ enum: QUALITY_SOURCES, nullable: true, description:
    'Which OSM signal seeded quality (osm_smoothness|osm_surface|osm_highway); null when rider-only or unseeded.' })
  quality_source!: QualitySource | null;

  @ApiProperty({ nullable: true, description:
    'OSM-derived quality estimate [1,5] shown alongside the blended quality_score.' })
  osm_quality_seed!: number | null;
```

- [ ] **Step 2: Add the failing mapper test.** In `roads.service.spec.ts`, extend the `findNearby` test (or add one) to assert the fields are threaded through. If the spec uses a mocked repo returning rows, add `quality_source` + `osm_quality_seed` to the mock row and assert on the mapped DTO:

```typescript
it("findNearby maps quality_source + osm_quality_seed", async () => {
  jest.spyOn(segmentRepo, "query").mockResolvedValue([
    {
      id: "a",
      road_name: "X",
      road_number: null,
      quality_score: 3.6,
      curviness_score: 2,
      surface_type: "asphalt",
      length_m: 100,
      confidence: 20,
      reading_count: 1,
      last_updated: new Date(),
      distance_m: 12,
      quality_source: "osm_smoothness",
      osm_quality_seed: 4,
    },
  ]);
  const [dto] = await service.findNearby({ lng: 0, lat: 0 } as never);
  expect(dto.quality_source).toBe("osm_smoothness");
  expect(dto.osm_quality_seed).toBe(4);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- roads.service`
Expected: FAIL — `dto.quality_source` undefined.

- [ ] **Step 4: Thread the columns through `findNearby`.** Add to the SELECT list and the `.map` object:

In the SQL SELECT (after `rs.confidence, rs.reading_count, rs.last_updated,`):

```sql
        rs.confidence, rs.reading_count, rs.quality_source, rs.osm_quality_seed, rs.last_updated,
```

In the `.map((row) => ({ ... }))` object (after `reading_count`):

```typescript
      reading_count: row.reading_count as number,
      quality_source: (row.quality_source as QualitySource) ?? null,
      osm_quality_seed: (row.osm_quality_seed as number) ?? null,
```

Add the `QualitySource` import at the top of `roads.service.ts` (alongside the existing `SurfaceType` import from `@tarmoto/shared`).

- [ ] **Step 5: Thread through `findById` (aggregated way).** In the aggregation SELECT (after the `surface_type` ARRAY_AGG line), add a length-weighted seed and a dominant source (mirrors how `surface_type` picks the longest sub-segment):

```sql
        (ARRAY_AGG(rs.surface_type ORDER BY rs.length_m DESC, rs.id))[1] AS surface_type,
        (ARRAY_AGG(rs.quality_source ORDER BY rs.length_m DESC, rs.id))[1] AS quality_source,
        SUM(rs.osm_quality_seed * rs.length_m) FILTER (WHERE rs.osm_quality_seed IS NOT NULL)
          / NULLIF(SUM(rs.length_m) FILTER (WHERE rs.osm_quality_seed IS NOT NULL), 0) AS osm_quality_seed,
```

In the final `return { ... }` object (after `surface_type`):

```typescript
      surface_type: row.surface_type as SurfaceType,
      quality_source: (row.quality_source as QualitySource) ?? null,
      osm_quality_seed: (row.osm_quality_seed as number) ?? null,
```

- [ ] **Step 6: Run to verify the mapper tests pass**

Run: `pnpm --filter @tarmoto/backend test -- roads.service`
Expected: PASS.

- [ ] **Step 7: Typecheck (strict) + regenerate the contract**

Run: `pnpm --filter @tarmoto/backend build`
Expected: exits 0 (strict `noUncheckedIndexedAccess`).

Run: `pnpm openapi:gen`
Expected: `packages/openapi-client/src/generated/schema.d.ts` regenerates; `git diff` shows `quality_source?` (enum) + `osm_quality_seed` added to `RoadSegmentDto`.

Run: `pnpm postman:gen`
Expected: postman collection regenerates in lockstep.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/roads/dto/road-segment.dto.ts apps/backend/src/modules/roads/roads.service.ts apps/backend/src/modules/roads/roads.service.spec.ts packages/openapi-client/src/generated/schema.d.ts packages/openapi/openapi.yaml packages/openapi/postman/tarmoto-api.postman_collection.json
git commit -m "feat(openapi): expose road quality_source + osm_quality_seed on the road DTO

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Mobile road-detail labeling (+ confidence-render fix)

**Files:**

- Modify: `apps/mobile/src/theme/index.ts:18-25` (add `qualityProvenanceLabel`)
- Modify: `apps/mobile/src/screens/RoadPreviewScreen.tsx:236-297` (QualityCard badge + confidence fix)
- Test: `apps/mobile/src/theme/__tests__/qualityProvenanceLabel.test.ts` (create)

**Interfaces:**

- Consumes: `Schemas["RoadSegmentDetailDto"]` (now carries `quality_source`, `osm_quality_seed`, `reading_count`).
- Produces: `qualityProvenanceLabel(source: QualitySource | null, readingCount: number): string | null`.

- [ ] **Step 1: Write the failing helper test** `qualityProvenanceLabel.test.ts`:

```typescript
import { qualityProvenanceLabel } from "../index";

describe("qualityProvenanceLabel", () => {
  it("labels an OSM estimate when no rider has reported", () => {
    expect(qualityProvenanceLabel("osm_smoothness", 0)).toBe(
      "Estimated from surveyed smoothness",
    );
    expect(qualityProvenanceLabel("osm_surface", 0)).toBe(
      "Estimated from road surface",
    );
    expect(qualityProvenanceLabel("osm_highway", 0)).toBe(
      "Estimated from road type",
    );
  });
  it("returns null once riders have contributed (verified by data)", () => {
    expect(qualityProvenanceLabel("osm_highway", 3)).toBeNull();
  });
  it("returns null when there is no source", () => {
    expect(qualityProvenanceLabel(null, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/mobile test -- qualityProvenanceLabel`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper** in `apps/mobile/src/theme/index.ts`:

```typescript
import type { QualitySource } from "@tarmoto/shared";

/**
 * Label a quality score's provenance for road-detail UI. Returns an "estimated"
 * string ONLY when the score is still purely OSM-seeded (no rider reports);
 * once riders contribute (`readingCount > 0`) the blended score is rider-backed,
 * so no estimate caveat is shown (design 2026-07-15).
 */
export function qualityProvenanceLabel(
  source: QualitySource | null,
  readingCount: number,
): string | null {
  if (readingCount > 0 || source === null) return null;
  switch (source) {
    case "osm_smoothness":
      return "Estimated from surveyed smoothness";
    case "osm_surface":
      return "Estimated from road surface";
    case "osm_highway":
      return "Estimated from road type";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @tarmoto/mobile test -- qualityProvenanceLabel`
Expected: PASS.

- [ ] **Step 5: Render the badge + fix the confidence bug** in `RoadPreviewScreen.tsx`. Import the helper, then in the `QualityCard` (below the `qualitySubtitle` line ~L258) add:

```tsx
{
  qualityProvenanceLabel(segment.quality_source, segment.reading_count) ? (
    <Text style={styles.qualityEstimate}>
      {qualityProvenanceLabel(segment.quality_source, segment.reading_count)}
    </Text>
  ) : null;
}
```

Add a `qualityEstimate` style near the other quality styles:

```typescript
  qualityEstimate: { fontSize: 12, color: UNSCORED_COLOR, marginTop: 2, fontStyle: 'italic' },
```

Fix the confidence render bug (HeaderCard meta pill ~L247) — `confidence` is already `0–100`, so drop the `* 100`:

```tsx
<MetaPill
  icon="shield-check"
  label={`${Math.round(segment.confidence)}% confidence`}
/>
```

- [ ] **Step 6: Run the screen tests + typecheck**

Run: `pnpm --filter @tarmoto/mobile test -- RoadPreviewScreen`
Expected: PASS.
Run: `pnpm --filter @tarmoto/mobile typecheck` (or `tsc --noEmit` per the mobile script)
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/theme/index.ts apps/mobile/src/theme/__tests__/qualityProvenanceLabel.test.ts apps/mobile/src/screens/RoadPreviewScreen.tsx
git commit -m "feat(mobile): label OSM-estimated road quality + fix confidence render

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Companion road-detail labeling

**Files:**

- Modify: `apps/companion/src/lib/utils.ts` (add `qualityProvenanceLabel`)
- Modify: `apps/companion/src/components/RoadPreviewCard.tsx:143-147` (estimated treatment)
- Test: `apps/companion/src/lib/utils.test.ts` (append)

**Interfaces:**

- Consumes: the view model behind `RoadPreviewCard` (segment carries `qualitySource`/`readingCount` mapped from the DTO's `quality_source`/`reading_count`).
- Produces: `qualityProvenanceLabel(source, readingCount)` (companion copy).

- [ ] **Step 1: Write the failing test** in `apps/companion/src/lib/utils.test.ts`:

```typescript
import { qualityProvenanceLabel } from "./utils";

describe("qualityProvenanceLabel", () => {
  it("describes an OSM estimate only before riders report", () => {
    expect(qualityProvenanceLabel("osm_surface", 0)).toBe(
      "Estimated from road surface",
    );
    expect(qualityProvenanceLabel("osm_smoothness", 0)).toBe(
      "Estimated from surveyed smoothness",
    );
    expect(qualityProvenanceLabel("osm_highway", 0)).toBe(
      "Estimated from road type",
    );
    expect(qualityProvenanceLabel("osm_surface", 2)).toBeNull();
    expect(qualityProvenanceLabel(null, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/companion test -- utils`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** in `apps/companion/src/lib/utils.ts` (mirror the mobile copy):

```typescript
import type { QualitySource } from "@tarmoto/shared";

/** Road-detail provenance label — "estimated" only while purely OSM-seeded
 *  (no rider reports); null once riders back the blended score (design 2026-07-15). */
export function qualityProvenanceLabel(
  source: QualitySource | null,
  readingCount: number,
): string | null {
  if (readingCount > 0 || source === null) return null;
  switch (source) {
    case "osm_smoothness":
      return "Estimated from surveyed smoothness";
    case "osm_surface":
      return "Estimated from road surface";
    case "osm_highway":
      return "Estimated from road type";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @tarmoto/companion test -- utils`
Expected: PASS.

- [ ] **Step 5: Render in `RoadPreviewCard.tsx`.** Ensure the card's segment view model exposes `qualitySource` + `readingCount` (map them where the `RoutePreviewSegment` is built from the DTO — search the planner mapping and add `qualitySource: dto.quality_source, readingCount: dto.reading_count`). Then below the "Quality score" Stat (~L147) add:

```tsx
{
  qualityProvenanceLabel(
    segment.qualitySource ?? null,
    segment.readingCount ?? 0,
  ) ? (
    <p className="text-xs italic text-fg-mute">
      {qualityProvenanceLabel(
        segment.qualitySource ?? null,
        segment.readingCount ?? 0,
      )}
    </p>
  ) : null;
}
```

- [ ] **Step 6: Typecheck (companion CI typechecks tests too) + test**

Run: `pnpm --filter @tarmoto/companion test -- RoadPreviewCard utils`
Expected: PASS.
Run: `pnpm --filter @tarmoto/companion typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/lib/utils.ts apps/companion/src/lib/utils.test.ts apps/companion/src/components/RoadPreviewCard.tsx
git commit -m "feat(companion): label OSM-estimated road quality on the road preview card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred (explicit non-goals of this plan)

Logged so coverage isn't mistaken for complete:

- **Map-level estimated-vs-verified distinction.** Seeded `quality_score` colors the map for free once tiles regenerate, but a _visual_ estimated marker (dashed/hatched line) needs `quality_source` emitted into the **MVT tiles** (mobile `qualityLineStyle`, companion `QUALITY_LINE_COLOR`) — a separate tile-pipeline change.
- **Sibling road DTOs** (`RouteQualitySegmentDto`, `BestRoadDto`, `FunZoneRoadDto`) do not inherit `RoadSegmentDto`; they keep rider-only quality display for now.
- **Confidence-scale unification** across apps (three incompatible scales; companion `confidenceLabel`/`confidenceColor` dead code expecting 0–1). This plan fixes only the one bug in the mobile screen it edits.
- Sub-projects **B** (road-extract folder model + refresh-container producer) and **C** (admin UI + `RoadImportSource` provider seam), per the spec.
- `k` varying by `quality_source`; an eager post-import re-blend pass for seed-changed segments that already have readings.

## Self-Review

- **Spec coverage:** data model (Task 4), seed derivation incl. all 3 tables + precedence (Task 2), blend + importer gate (Tasks 4–5), `quality_source`/`osm_quality_seed` contract (Task 6, on base `RoadSegmentDto` — a deliberate correction of the spec's `QualityBreakdownDto` placement, which is a %-object), client labeling (Tasks 7–8), testing (unit + real-PG e2e gate), rollout (empty-table migration, no backfill). Map labeling explicitly deferred with rationale. ✔
- **Placeholder scan:** none — every code step carries full code; SQL fn reproduced in full in both `up()`/`down()`. ✔
- **Type consistency:** `qualitySeedFromTags → QualitySeed{score,source}` consumed identically in Task 3; `QualitySource` from `@tarmoto/shared` used in shared/backend/mobile/companion; `QUALITY_SEED_PRIOR_WEIGHT=4` mirrors the SQL literal `* 4 / (… + 4)`; `quality_source`/`osm_quality_seed` names identical across entity, migration, row, upsert, DTO, mappers, clients. ✔
