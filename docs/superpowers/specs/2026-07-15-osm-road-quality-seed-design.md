# OSM Road-Quality Seed + Confidence Blend — Design

- **Date:** 2026-07-15
- **Status:** Approved (design); implementation plan pending
- **Scope:** Sub-project **A** of a 3-part effort to generalize the POI data pipeline to the road-network / `road_segments` subsystem.

## Context & motivation

Road-surface quality is a headline product claim, normally derived from rider tracking (`surface_readings` → `road_segments.quality_score`, an outlier-filtered, recency-weighted mean). At launch there are **no riders**, so `quality_score` would be `NULL` (neutral) everywhere and the map/routing would show no quality signal.

OSM ways carry crowdsourced quality signals — primarily the `smoothness` tag, plus `surface` and the `highway` class — that we can use to **pre-seed** quality before riders exist. The road importer already does exactly this for surface (`surface_type` is seeded from OSM `surface`, sticky via `surface_from_reading`, #796); this design adds the analogous quality seed and blends it with rider data by confidence.

This is **Sub-project A** (the launch-critical data piece). It is standalone: it ships against the road import exactly as it exists today (still single-file `TARMOTO_OSM_IMPORT_FILE`). The other two sub-projects are follow-ups, out of scope here:

- **B** — retire single-file `TARMOTO_OSM_IMPORT_FILE` for a folder model + a road-extract producer in the refresh container.
- **C** — admin UI hooks (inspect/trigger/upload road extracts) + a `RoadImportSource` multi-provider strategy seam (the "fsq of roads").

The road subsystem is currently **dormant** (`osmImportConfig.enabled` defaults false, never deployed), so `road_segments` is empty in prod.

## Key decisions

1. **Broadest coverage.** Seed every drivable way: `smoothness` → `surface` → `highway` class, first hit wins. Accepts that the highway-class fallback is a weak proxy, in exchange for quality showing everywhere at launch.
2. **Provenance is tracked and surfaced.** A `quality_source` column records which signal fed the seed, exposed through the contract so clients can distinguish estimated from rider-verified (a highway-class guess must not read as verified fact).
3. **Dual-value confidence blend, not sticky overwrite.** The OSM seed and rider data coexist; the displayed `quality_score` is a Bayesian blend weighted by rider report count. One rider does not fully override OSM; many do.
4. **`k = 4`** as the launch prior weight (tunable).

## Data model

Migration adds two nullable columns to `road_segments` (additive; safe on the empty prod table):

| Column             | Type               | Meaning                                                                                                                                                                |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `osm_quality_seed` | `float NULL`       | OSM-derived prior, `[1,5]`. Refreshed from tags on **every** import. Never owned away by riders.                                                                       |
| `quality_source`   | `varchar(20) NULL` | Which signal fed the seed: `osm_smoothness` \| `osm_surface` \| `osm_highway`. `NULL` when a way matches none (rare — nearly all drivable ways carry a `highway` tag). |

**No new sticky flag** (unlike surface's `surface_from_reading`): the blend _is_ the priority mechanism.

**`quality_score` changes meaning** from the rider-only mean to the **effective blend**. Every existing consumer (map tiles, routing, quality→smoothness conflation, DTOs) keeps reading this one column and transparently gains the seed. Reused existing columns:

- `reading_count` (`int`) — the blend's `n` (rider report count).
- `confidence` (`int`, 0–100) — left as-is; available to the client confidence indicator.

**No prod backfill** — `road_segments` is empty in prod; columns default `NULL` and populate on the first real import. Demo/dev seed data picks up seeds on its next import (the demo seeder is noted for the plan).

## Seed derivation

New pure module `apps/backend/src/modules/roads/osm-import/quality-seed.ts`:

```ts
qualitySeedFromTags(tags): { score: number | null; source: QualitySource | null }
```

Unit-tested in isolation (like `qualityScoreToSmoothness`), then wired into `roadFieldsFromTags` / `segment-rows.ts` so each `RoadSegmentRow` carries `osm_quality_seed` + `quality_source`. **Precedence: `smoothness` → `surface` → `highway`, first hit wins.**

**1. `smoothness`** — inverse of the ADR-0005 anchor mapping (`qualityScoreToSmoothness`); worse-than-scale tiers clamp to 1:

| OSM `smoothness`                                      | seed |
| ----------------------------------------------------- | ---- |
| `excellent`                                           | 5    |
| `good`                                                | 4    |
| `intermediate`                                        | 3    |
| `bad`                                                 | 2    |
| `very_bad`, `horrible`, `very_horrible`, `impassable` | 1    |

**2. `surface`** — material as a quality proxy:

| OSM `surface`                                                         | seed |
| --------------------------------------------------------------------- | ---- |
| `asphalt`, `concrete`, `concrete:plates`, `paving_stones`, `chipseal` | 4    |
| `sett`, `cobblestone`, `compacted`, `fine_gravel`, `metal`, `wood`    | 3    |
| `gravel`, `pebblestone`, `ground`, `dirt`, `earth`, `unpaved`         | 2    |
| `sand`, `mud`, `grass`, `clay`                                        | 1    |

**3. `highway` class** — last resort (weak proxy):

| OSM `highway`                                                                 | seed |
| ----------------------------------------------------------------------------- | ---- |
| `motorway`, `trunk`, `primary`, `secondary` (+ `_link`)                       | 4    |
| `tertiary`, `unclassified`, `residential`, `living_street`, `service`, `road` | 3    |
| `track`                                                                       | 2    |

Unmatched at all three levels → `{ score: null, source: null }` (effective quality then comes purely from riders, or stays neutral). All three tables are tunable defaults in one reviewable file.

## The blend (importer + aggregation coexistence)

`quality_score` (the effective value) has **two writers**, mirroring the surface seed:

**① The OSM importer** (in the upsert): always writes `osm_quality_seed` + `quality_source` from the fresh tags. For `quality_score` it uses a `CASE` gate on `reading_count` (the analog of surface's `surface_from_reading` gate):

- `reading_count = 0` → `quality_score = osm_quality_seed` (pure seed).
- `reading_count > 0` → leave `quality_score` unchanged (riders already blended; do not clobber).

**② `update_road_quality_for_segment`** (runs on reading changes): computes `rider_mean` + `n` as today, then writes the blend instead of the raw mean:

```
quality_score = (rider_mean · n + osm_quality_seed · k) / (n + k)
```

- `osm_quality_seed IS NULL` → falls back to `rider_mean` (rider-only, no prior).
- `k = 4` — a single named constant (SQL + a TS reference), tunable.

**Worked example** (`osm_seed = 4`, `k = 4`):

| rider reports `n` | `rider_mean` | effective `quality_score` |
| ----------------- | ------------ | ------------------------- |
| 0                 | –            | 4.0 (OSM only)            |
| 1                 | 2.0          | 3.6                       |
| 4                 | 2.0          | 3.0 (50/50)               |
| 20                | 2.0          | 2.3                       |

**Edge — null seed:** with the highway fallback the seed is set for nearly every drivable way; only an unrecognized `highway` yields `NULL` → neutral until riders (today's behavior).

**Staleness (accepted, YAGNI):** for a segment that already has readings, a re-import refreshes `osm_quality_seed` but the blend's seed component only updates on that segment's next aggregation run. Impact is negligible — high-`n` segments barely weight the seed, and imports are weekly. An eager re-blend pass is a possible follow-up, not in A.

**Consumers unchanged:** tiles, routing, the quality→smoothness conflation, and DTOs all keep reading `quality_score` and now receive seeded/blended values. The conflation is unchanged code — it simply gets more non-null values to tag.

## Contract + client labeling

DTO changes (kept additive here because it's clean, though the pre-production test phase permits breaking changes — the whole contract chain is regenerated together regardless):

- `RoadSegmentDto` (list/map): **+ `quality_source: 'osm_smoothness' | 'osm_surface' | 'osm_highway' | null`**. (`quality_score` = effective, `confidence` 0–100, `reading_count` already present.)
- `QualityBreakdownDto` (road detail, on `RoadSegmentDetailDto`): **+ `osm_quality_seed: number | null`** — the OSM estimate shown next to the effective score. This is the "2 values": _"OSM estimate 4 → now 3.6 from 12 reports."_ The pure rider mean stays internal (not exposed; not stored as a column).

**Contract chain** (kept aligned per repo rules): backend DTO → regenerate OpenAPI spec + typed client → `@tarmoto/shared` types → mobile + companion consumers.

**Labeling principle** (the _what_; exact visual treatment decided during the client slice):

- Effective quality now renders on **every** seeded segment, not just rider-covered ones.
- `reading_count === 0` → "**Estimated** from {surveyed smoothness · road surface · road type}" (text keyed off `quality_source`); `> 0` → the existing confidence indicator, now meaning "OSM prior + N reports."
- Road detail shows the OSM-estimate-vs-current breakdown.

**Client touchpoints** (quality-display surfaces only): mobile map color/legend + road detail + road preview card; companion `QualityMap` + road preview + zone/road detail. The exact "estimated" visual treatment (dashed/hatched segment, badge, dimmed color) is an implementation detail; may be mocked in a browser tab during the client slice.

**Assumption to revisit (UI default):** lead with the single blended value + a confidence indicator; raw components available in road detail. The contract carries everything either way, so this is not architecturally binding.

## Testing

**Unit (pure, exhaustive):**

- `quality-seed.ts` — every band in all three tables, the smoothness → surface → highway precedence, the worse-than-scale clamp (`horrible` → 1), and the all-miss → `{ null, null }` case.
- The blend math — a documented reference mirroring the SQL: `n = 0` → seed, `osm_seed = null` → rider-only, `n ≫ k` → rider-dominant, and the worked-example rows.

**Integration / e2e (real PostgreSQL — the aggregation is a SQL function, so it follows the existing manual pre-release e2e gate, as POI coverage does):**

- Importer writes `osm_quality_seed` + `quality_source` from synthetic ways; `reading_count = 0` segments get `quality_score = seed`.
- After readings, `update_road_quality_for_segment` produces the blend; a re-import refreshes the seed without clobbering a blended segment.

**Contract/clients:** DTO fields present + OpenAPI regenerated; mobile/companion tests assert the estimated-vs-verified label keys off `quality_source` / `reading_count`.

## Rollout

The product is **pre-production** (test phase, no live users), so no gradual/continuous rollout is required and **breaking changes are acceptable** — just migrate and deploy:

- The migration adds columns to an empty table (road subsystem dormant), so there is no backfill and no compatibility constraint.
- `quality_score` changing meaning (rider-mean → effective blend) and the DTO changes need no compat shims; the whole contract chain (OpenAPI + typed client + `@tarmoto/shared` + clients) is regenerated together.
- Quality appears once an operator enables + runs the road import (a separate ops action).

## Out of scope / follow-ups

- **Sub-project B** — road-extract folder model + refresh-container producer (retire `TARMOTO_OSM_IMPORT_FILE`).
- **Sub-project C** — admin UI hooks + `RoadImportSource` multi-provider seam.
- `k` varying by `quality_source` (a real smoothness prior deserves more weight than a highway-class guess).
- An eager post-import re-blend pass for seed-changed segments that already have readings.
- The exact "estimated" visual treatment on mobile/companion.
