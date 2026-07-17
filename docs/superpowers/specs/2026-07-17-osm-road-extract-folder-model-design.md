# OSM Road Extract Producer + Folder-Model Import — Design

**Status:** Approved design (high level); spec under review.
**Date:** 2026-07-17
**Sub-project:** B of the road-quality-seed epic. Sub-project A shipped in PR #997 (`docs/superpowers/specs/2026-07-15-osm-road-quality-seed-design.md`). C (admin hooks + `RoadImportSource` multi-provider seam) remains deferred.

## Goal

Retire the road importer's single-file / single-bbox extract model and replace it with the same **automated, per-region folder model** the POI pipeline already uses: a road-extract **producer** in `apps/ingest` writes one `.osm` extract per region into a shared volume, and the backend road importer reads that folder and imports every configured region in one pass. The road subsystem stays **dormant** (ships dark); this only changes _how the extract gets produced and consumed_, not any served behaviour.

## Background & motivation

Sub-project A (#997) added the OSM quality **seed** (smoothness→surface→highway → `quality_score` via Bayesian confidence weighting, `quality_source` tracking, migration 1811). The importer that populates `road_segments` from OSM, however, still predates the POI work:

- It reads **one** operator-prepared `.osm` file (`TARMOTO_OSM_ROAD_IMPORT_FILE`).
- Its stale-by-absence tombstoning is scoped to **one** operator-supplied rectangle (`TARMOTO_OSM_ROAD_IMPORT_BBOX`), and the config contract demands the operator hand-clip the extract to _exactly_ that rectangle.
- There is **no producer** — someone has to build the extract by hand.

Meanwhile the POI pipeline (#976) fully automated its extract production: a refresh script in the ingest/extractor container downloads each region's Geofabrik country PBF, filters it, `osmium extract -b`s it to the region bbox, and writes `<code>.osm` atomically into a shared volume; the importer then reads the whole folder on a schedule. Sub-project B brings the road importer onto that same model, reusing the POI machinery, so the two OSM-sourced imports (`osm_poi`, `osm_road`) are operationally symmetric.

## Scope

**In scope**

1. **Road-extract producer** in `apps/ingest` (`refresh-road-extracts.ts`) mirroring `refresh-poi-extracts.ts`, with a road (drivable-highway) tag filter instead of the POI tag filter. Writes `<code>.osm` per region into the shared extract dir, atomically.
2. **Folder-model road import** in `apps/backend`: `osm-import.config` switches from `{ filePath, bbox }` to `{ extractDir, regions }`; `OsmImportService` grows an `importAll()` that loops the configured regions, reconciling each against its own bbox; the processor calls `importAll()` in place of `importFromConfiguredFile()`.
3. **quality-conflation bbox decouple** (forced): `quality-conflation.service` currently reads `osmRoadImportConfig.bbox`. Removing the single bbox forces a change; it defaults to **whole-network** scope (which it already supports and which is the _correct_ scope once the import spans multiple regions).
4. **Shared drivable-highway list**: hoist `DRIVABLE_HIGHWAYS` to `@tarmoto/ingest` so the producer's extract filter and the backend importer reference **one** source (no drift → no silent coverage gap).
5. **Minimal safety guard**: a per-region "empty/absent extract → skip (do not tombstone)" guard, since the refresh is now automated and an empty extract must never wipe a region.
6. Env delta, `.env.example` updates, both Dockerfiles / docker-compose, architecture + runbook docs, and the config contract comment rewrite (exact-clip → complete_ways).

**Out of scope**

- **Folder-model-izing quality-conflation / graphhopper-reimport.** These stay single-input-file → single-output-file. quality-conflation is a separate dormant GraphHopper-feedback subsystem (#779, ADR-0005); only its _bbox coupling_ is touched here. Making it per-region is future work (C or later).
- Admin UI hooks for road import, and the `RoadImportSource` multi-provider seam — **Sub-project C**.
- Any DB schema / migration change. `road_segments` stays exactly as A left it, on the default (main-app) connection. No OpenAPI/contract change. No backward-compat shim (pre-production; breaking env vars is acceptable).
- A full `MAX_TOMBSTONE_FRACTION`-style guard (POI-style). YAGNI for a dormant subsystem; the empty-extract skip covers the real automation risk.

## Architecture overview

Two halves, exactly mirroring POI:

```
apps/ingest (extractor container)           apps/backend (worker)
─────────────────────────────────           ─────────────────────
refresh-road-extracts.ts                     road.import queue (weekly cron)
  per region:                                  OsmImportProcessor.process()
    download Geofabrik PBF        ┌──────┐       OsmImportService.importAll()
    osmium tags-filter (roads) ── │shared│ ──►     per region:
    osmium extract -b (bbox)      │volume│           read <dir>/<code>.osm
    atomic write <code>.osm       └──────┘           reconcile vs region bbox
                                                    → road_segments (main DB)
                                                  chain enqueueQualityConflation() once
```

- The producer runs in the **ingest** container (it already hosts `osmium` + the Geofabrik download path for POI). It is an external scheduled `docker exec` task (like the POI OSM refresh), **not** an in-app scheduler.
- The importer stays in the **backend** because `road_segments` lives on the backend's default DB connection (`roads.module.ts`, no connection name). B does **not** move road ingestion into `apps/ingest`; only the _extract production_ moves.
- The two share one **volume** — ingest writes, backend reads. (Simpler than POI's read-write-both; roads have no admin upload path in B.)

## Component design

### 1. Road-extract producer (`apps/ingest`)

**New:** `apps/ingest/src/scripts/refresh-road-extracts.ts` — a near-verbatim structural copy of `refresh-poi-extracts.ts`:

- Same `RefreshDeps` seam (`download`, `osmium`), same atomic `.part`-then-`rename`, same `refreshRegion` / `refreshAll` per-region loop, same env-gated `main()`.
- Reuses `refresh-common.ts` verbatim (it is already generic — download/osmium/temp-path helpers).
- Reuses the geographic helpers from `packages/ingest/src/poi/`: `PoiImportRegion`, `DEFAULT_REGIONS` (the 17 countries), `parseRegions`, `geofabrikUrl` / `GEOFABRIK_SLUGS`, `bboxArg`. These are geographic, not POI-specific; a future cleanup could hoist them to a neutral module, but B imports them from `../poi/` with a comment (no churn).
- **Differs** only in the osmium `tags-filter` step: instead of `POI_TAGS_FILTER_EXPRESSIONS`, it filters to drivable highways.

**New:** `packages/ingest/src/roads/road-refresh-config.ts` — the road analogue of `packages/ingest/src/poi/refresh-config.ts`. Exports `ROAD_TAGS_FILTER_EXPRESSIONS` = a single osmium expression `w/highway=<DRIVABLE_HIGHWAYS joined by ",">`. (Ways only; the fine access/service gating is deliberately left to the backend importer — the extract is a coarse **superset**.)

**Extract strategy — `complete_ways` (osmium default).** `osmium extract -b` defaults to `-s complete_ways`: any way with ≥1 node in the bbox is emitted **complete** (all nodes, even out-of-bbox). This is what the producer inherits (no `-s` flag), matching the POI refresh. Consequences (see _Edge cases_): border-crossing ways are emitted complete and identical in every adjacent region's extract, and tombstoning stays safe.

**Env (producer):** `TARMOTO_OSM_ROAD_REFRESH_ENABLED` gates `main()` (mirror the POI OSM refresh's gating), reuses `TARMOTO_OSM_ROAD_IMPORT_DIR` (target dir) and `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (which regions) — the same two vars the importer reads, so refresh and import agree on _what_ and _where_ by construction. The producer runs in the ingest container and the importer in the backend container, so `_DIR` and `_REGIONS` must be set (identically) on **both** Coolify apps; sharing the var _names_ is deliberate — a single conceptual source of truth prevents refresh/import region drift, matching the POI pipeline.

**Scheduling:** an ingest Coolify scheduled task, `node apps/ingest/dist/scripts/refresh-road-extracts.js`, weekly (staggered from the POI OSM refresh, e.g. Sat 03:00), documented in the Dockerfile header + runbook.

### 2. Folder-model road import (`apps/backend`)

**`osm-import/osm-import.config.ts`:**

```ts
export interface RoadImportConfig {
  enabled: boolean;
  extractDir: string | null; // was: filePath
  regions: PoiImportRegion[]; // was: bbox: [n,n,n,n] | null
}
```

- Drop `parseBbox`; read `extractDir` from `TARMOTO_OSM_ROAD_IMPORT_DIR` and `regions` from `TARMOTO_OSM_ROAD_IMPORT_REGIONS` via the reused `parseRegions` (defaulting to `DEFAULT_REGIONS` when unset, exactly like POI).
- **Rewrite the contract comment**: the old "extract MUST be bbox-clipped to exactly this rectangle" is replaced by the `complete_ways` contract — extracts are complete-way `osmium extract -b` outputs; tombstoning is safe because complete_ways never drops a way that touches the bbox.

**`osm-import/osm-import.service.ts`:**

- Add `importAll(): Promise<{ upserted: number }>` — loops `config.regions`; for each region resolves `join(config.extractDir, region.code.toLowerCase() + '.osm')`, and:
  - **absent file → skip** with a warn (never fail the whole run for one missing region — mirrors POI's skip-if-missing).
  - parse the extract; **0 ways → skip** the region with a warn (**empty-extract guard**: never tombstone a region from an empty/corrupt extract).
  - otherwise `reconcile(...)` scoped to that region's bbox.
- `reconcile()` / `loadExistingInBbox()` already take a bbox tuple `[minLng,minLat,maxLng,maxLat]`. `PoiImportRegion.bbox` is an **object** `{ minLng, minLat, maxLng, maxLat }` — convert via a small `bboxTuple(region.bbox)` helper at the call boundary (do **not** thread the object into the SQL layer).
- `importFromConfiguredFile()` is removed (replaced by `importAll()`); `enabled` stays.
- Aggregate `upserted` across regions for the return/log.

**`jobs/processors/osm-import.processor.ts`:**

- Call `this.osmImport.importAll()` instead of `importFromConfiguredFile()`.
- The `enqueueQualityConflation()` chain is **unchanged** — it still fires **once**, after the whole multi-region import succeeds. Because the import remains a single job that loops regions internally (not a per-region fan-out), there is exactly one conflation enqueue per weekly run, with no 17× fan-out and no race against a fixed-time cron.

**No scheduler change.** The `road.import` weekly cron already exists; the job simply does more internally. quality-conflation remains a success-continuation (no independent cron).

### 3. quality-conflation bbox decouple (`apps/backend`) — forced-in-scope, minimal

`quality-conflation.service.ts` injects `osmRoadImportConfig` solely to read `this.config.bbox`, which it uses to scope its DB query (`bbox ? "within region […]" : "(whole network)"`). Removing the single bbox forces a change. The minimal, semantically-correct fix:

- Remove the `@Inject(osmRoadImportConfig.KEY)` dependency from `quality-conflation.service`.
- Scope the conflation query to **whole network** (the `bbox === null` branch it already implements). Once the import spans cz/sk/at, "whole network" is the correct scope — the operator-provided input extract (`TARMOTO_QUALITY_CONFLATION_INPUT_FILE`) naturally bounds which ways actually get tagged, so pulling all scores is correct and harmless.
- Update `quality-conflation.service.spec.ts` (drop the bbox-scoping assertions; assert whole-network).
- If `parseBbox` / the `bbox` field is now unused everywhere, delete it (dead-code sweep).

quality-conflation's own `enabled` / `INPUT_FILE` / `OUTPUT_FILE` envs and its single-file behaviour are **untouched**. It is explicitly **not** folder-model-ized in B.

### 4. Shared drivable-highway list

Hoist `DRIVABLE_HIGHWAYS` (currently a private `Set` in `apps/backend/src/modules/roads/osm-import/osm-tags.ts`) into `@tarmoto/ingest` (e.g. `packages/ingest/src/roads/road-tags.ts`). The backend importer re-imports it (backend already depends on `@tarmoto/ingest`), and the producer's `ROAD_TAGS_FILTER_EXPRESSIONS` builds `w/highway=<list>` from the same constant. One source ⇒ the extract filter can never silently drop a highway class the importer wants.

### 5. Other touch points to verify

- `jobs/queue-health.service.ts` reads the road-import config — confirm it references only `enabled` / the queue name (both survive), not the removed `.bbox` / `.filePath`.
- `graphhopper-reimport.*` does **not** read `osmRoadImportConfig` (verified) — untouched.

## Data flow

1. **Refresh (weekly, ingest container):** for each region in `TARMOTO_OSM_ROAD_IMPORT_REGIONS` — download Geofabrik PBF → `osmium tags-filter w/highway=…` → `osmium extract -b <bbox>` (complete_ways) → atomic write `<code>.osm` into `TARMOTO_OSM_ROAD_IMPORT_DIR`. Keep-last-good on any failure.
2. **Import (weekly cron, backend worker):** `road.import` tick → skip if `!enabled` → `importAll()` loops regions → per region: skip if file absent or 0 ways, else reconcile against the region bbox (upsert OSM-owned columns, tombstone in-bbox absentees) → aggregate `upserted` → chain `enqueueQualityConflation()` once.
3. **Conflation (chained, dormant unless enabled):** whole-network smoothness injection into the operator-provided input extract → output extract for GraphHopper. Unchanged except the bbox scope.

## Environment variable delta

| Var                                                                   | Change      | Read by                             |
| --------------------------------------------------------------------- | ----------- | ----------------------------------- |
| `TARMOTO_OSM_ROAD_IMPORT_FILE`                                        | **removed** | (was) importer                      |
| `TARMOTO_OSM_ROAD_IMPORT_BBOX`                                        | **removed** | (was) importer + quality-conflation |
| `TARMOTO_OSM_ROAD_IMPORT_DIR`                                         | **added**   | importer + producer                 |
| `TARMOTO_OSM_ROAD_IMPORT_REGIONS`                                     | **added**   | importer + producer                 |
| `TARMOTO_OSM_ROAD_REFRESH_ENABLED`                                    | **added**   | producer (`main()` gate)            |
| `TARMOTO_OSM_ROAD_IMPORT_ENABLED`                                     | unchanged   | importer                            |
| `TARMOTO_QUALITY_CONFLATION_ENABLED` / `_INPUT_FILE` / `_OUTPUT_FILE` | unchanged   | quality-conflation                  |

## Edge cases & decisions

- **Border-crossing ways are safe — and the importer already handles this.** `reconcile()` was written for tiling ("tiles a large area into several sub-imports"): it filters the incoming rows to the region bbox (`intersectsRegion`, the same exact test `loadExistingInBbox` runs in PostGIS) so a `complete_ways` way straddling the cz/sk border contributes only its **in-bbox** segments to each region's run; a segment sitting exactly on the boundary is kept by both adjacent runs and upserts idempotently (identical geometry, identical `(osm_way_id, segment_index)`). Out-of-region segments are dropped, not tombstoned. So no cross-region dedup is needed — the folder model is exactly the tiling the service already anticipates; B parameterizes the region (was the single `this.config.bbox`) and loops.
- **Overlapping rectangular bboxes → benign redundant re-import.** Adjacent-country bbox _rectangles_ overlap, so eastern-CZ roads also fall inside SK's rectangle and get imported by both runs. Idempotent; wasted work only. Acceptable for a dormant weekly offline job.
- **Pathological corner-clip is a non-issue in practice.** The only way an in-bbox segment could be wrongly tombstoned is a single un-noded road edge spanning a country-bbox corner with _both_ endpoints outside the rectangle. Real OSM road ways are densely noded; this does not occur. Documented, not guarded.
- **Empty/absent extract never wipes a region — an intentional departure.** Absent file → skip; present-but-0-ways → skip **with a warning**. `reconcile()` today treats an empty tile _with a region_ as authoritative ("every road was removed → tombstone the region") — a sound choice for a hand-supplied single-file tile. The folder model's regions are automated whole-country extracts, where an empty result almost always means a **broken refresh**, not a genuinely empty country. So `importRegion()` guards 0-way extracts **before** calling `reconcile()`, overriding the authoritative-empty behavior for the folder path (the atomic keep-last-good refresh already prevents a _failed_ refresh from producing an empty file; this guards the operator-misconfiguration / corrupt-parse case). `reconcile()`'s own branch is left intact for its direct-source callers and tests.
- **complete_ways replaces the exact-clip contract.** The old config comment demanded operator-exact-clipping; that requirement is removed. complete_ways is strictly safer for tombstoning (never drops a bbox-touching way).

## Testing strategy

- **Producer** (`refresh-road-extracts.spec.ts`): mirror `refresh-poi-extracts.spec.ts` via the `RefreshDeps` seam — assert the osmium `tags-filter` args carry the road (`w/highway=…`) expression, `extract -b` carries the region bbox, atomic `.part`→rename, per-region loop, missing-Geofabrik-slug error, env gate.
- **Road tag filter** (`road-tags.spec.ts` / config): `ROAD_TAGS_FILTER_EXPRESSIONS` includes every `DRIVABLE_HIGHWAYS` member (superset guarantee), single `w/highway=` expression.
- **Import config**: `extractDir` / `regions` parsing, default-to-`DEFAULT_REGIONS`, `enabled` default false.
- **`importAll()`**: multi-region loop upserts each region against its own bbox; absent-file skip; **0-ways skip (no tombstone)**; `bboxTuple` object→tuple conversion; aggregate `upserted`. Reuse the existing reconcile/tombstone unit coverage from A per region.
- **quality-conflation**: whole-network scoping after the decouple (spec update).
- **Processor**: `importAll()` invoked; `enqueueQualityConflation()` called exactly once on success; skip path when disabled.
- **Gate every task** with a grep-for-old-token check (`TARMOTO_OSM_ROAD_IMPORT_FILE`, `TARMOTO_OSM_ROAD_IMPORT_BBOX`, `importFromConfiguredFile`, `parseBbox`) + build + lint + `openapi:gen` byte-identical (no contract change expected).

## Rollout

- **Dormant / dark.** `TARMOTO_OSM_ROAD_IMPORT_ENABLED` and `TARMOTO_OSM_ROAD_REFRESH_ENABLED` default false; nothing served changes. Safe to break env vars (pre-production; no users).
- **No migration.** `road_segments` unchanged.
- **Ops enablement (later, mirrors POI):** set `TARMOTO_OSM_ROAD_IMPORT_DIR` + `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (launch `cz,sk,at`) on the backend; add the ingest **road-refresh scheduled task** (weekly) + `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true`; the extract volume is already mounted on both apps. Then flip `TARMOTO_OSM_ROAD_IMPORT_ENABLED=true`.

## Risks & follow-ups

- The producer is the **first** consumer of `osmium extract -b` on _ways_ (POI extracts only nodes, for which strategy is irrelevant). complete_ways behaviour is verified against the local osmium default and analysed above, but the first real cz/sk/at road refresh should be sanity-checked (segment counts, border seams).
- **Road extracts are much larger than POI extracts** (the whole drivable network vs a sparse POI set), so the refresh is more download-, disk-, and memory-heavy. The ingest container already runs full-country PBF download + osmium for POI with the swap/perms hardening from the POI OOM fix (#989–#990), and osmium `tags-filter`/`extract` stream rather than load the whole PBF — but the first real refresh should watch container memory and extract sizes on the shared volume.
- Geographic helpers remain under `packages/ingest/src/poi/` while roads import them cross-domain — a wart, deferred to a neutral-module cleanup.
- Sub-project **C** (admin upload/trigger hooks for road import + `RoadImportSource` multi-provider seam) remains the next step after B.
