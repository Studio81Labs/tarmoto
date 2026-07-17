# Import Source/Domain Naming Rework — Design

**Status:** Approved (design)
**Date:** 2026-07-16
**Scope label:** `cross`

## Goal

Give every bulk import a consistent `{source}_{domain}` name so the three importers read as siblings — resolving the long-deferred inconsistency where the OSM-sourced POI import is named the generic `poi` while its Foursquare sibling is `fsq`, and disambiguating the two OSM-sourced imports (POIs vs road-quality) that both want the `osm` namespace.

| import                    | before                                                          | after                                                                           |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| OSM → POIs                | `poi` (`TARMOTO_POI_IMPORT_*`, `poiImportConfig`)               | `osm_poi` (`TARMOTO_OSM_POI_IMPORT_*`, `osmPoiImport`)                          |
| Foursquare → POIs         | `fsq` (`TARMOTO_FSQ_IMPORT_*`, `fsqImportConfig`)               | `fsq_poi` (`TARMOTO_FSQ_POI_IMPORT_*`, `fsqPoiImport`)                          |
| OSM → road quality (#781) | `osm` (`TARMOTO_OSM_IMPORT_*`, `osmImportConfig`, `osm.import`) | `osm_road` (`TARMOTO_OSM_ROAD_IMPORT_*`, `osmRoadImport`) + queue `road.import` |

## Background

`poi` predates `fsq`: when OSM was the only POI source its import was simply "the POI import". Foursquare (#869) arrived as an explicitly _source_-named second importer (`fsq`), leaving the original mis-named `poi`. Separately, the OSM road-quality seed (#781) claimed the `osm` namespace for `TARMOTO_OSM_IMPORT_*` / `osmImportConfig` / the `osm.import` queue.

A naive `poi → osm` rename was deferred earlier precisely because `osm` was already taken by roads. This design is the collision-aware version: both OSM-sourced imports are disambiguated by domain (`osm_poi`, `osm_road`), and Foursquare is normalised to `fsq_poi` so the two POI importers are truly parallel.

Post-extraction state (as of #1011/#1013): the POI import lives in `apps/ingest` + `@tarmoto/ingest`; the road-quality import lives in `apps/backend/src/modules/roads/` (dormant — ships dark). Neither shares env vars today (`poi`/`fsq` vs `osm` prefixes); the collision only materialises _if_ we rename, which is why disambiguation is the whole point.

## The naming model — two levels

The distinction the code already implies: **domain-level infrastructure is shared across sources and keeps its domain name; only the per-source importers get `{source}_{domain}`.**

### Stays domain-named (shared by all sources of a domain) — DO NOT rename

- The `poi.import` queue — it dispatches _both_ osm and fsq POI jobs (the source is a field in `PoiImportRegionJobData`). It is the POI _subsystem_ queue, correctly domain-named.
- `TARMOTO_POI_DATABASE_*`, the `pois` table, the `@tarmoto/poi-db` package, `PoiImportService`, `PoiImportProcessor`, `PoiImportScheduler` — the POI domain's DB + engine, shared by both sources.
- The `PoiImportConfig` interface — the shared _shape_ of a POI import config (both `osmPoiImport` and `fsqPoiImport` return it). It is domain-level; only the `registerAs` keys + env vars that populate it are per-source.
- The DB discriminator values themselves: `pois.source` stays `'osm'`/`'fsq'`; `road_segments.quality_source` stays `'osm_quality_seed'`. **No data migration.**

### Becomes `{source}_{domain}` (per-source importers)

- **registerAs keys / config instances:** `poiImport`→`osmPoiImport`, `fsqImport`→`fsqPoiImport`, `osmImport`→`osmRoadImport`.
- **Env vars (all suffixes):**
  - `TARMOTO_POI_IMPORT_{ENABLED,DIR,REGIONS}` → `TARMOTO_OSM_POI_IMPORT_{ENABLED,DIR,REGIONS}`; `TARMOTO_POI_REFRESH_ENABLED` → `TARMOTO_OSM_POI_REFRESH_ENABLED`.
  - `TARMOTO_FSQ_IMPORT_{ENABLED,DIR,REGIONS}` → `TARMOTO_FSQ_POI_IMPORT_{ENABLED,DIR,REGIONS}`; `TARMOTO_FSQ_REFRESH_ENABLED` → `TARMOTO_FSQ_POI_REFRESH_ENABLED`; `TARMOTO_FSQ_TOKEN` → `TARMOTO_FSQ_POI_TOKEN`.
  - `TARMOTO_OSM_IMPORT_*` (all road suffixes) → `TARMOTO_OSM_ROAD_IMPORT_*`. Audit the adjacent `quality-conflation` config for any `TARMOTO_OSM_*` reads and rename in step (its conflation of the osm seed is part of the road-quality subsystem).
- **Road config interface:** `OsmImportConfig` → `RoadImportConfig` (the road domain's config shape, parallel to `PoiImportConfig`), instance `osmRoadImport`.
- **Road queue:** `osm.import` → `road.import` (domain-level, parallel to `poi.import`); the continuation job constant + `queue-health` registry + the processor's `@Processor('osm.import')` follow. `ALL_QUEUE_NAMES` count is unchanged (still 14 — a rename, not an add/remove).

### Already correct (confirmation, no change)

- The POI source-strategy classes `OsmPoiImportSource` / `FsqPoiImportSource` are already `{source}Poi…` — they validate the chosen scheme.

## What explicitly does NOT change

- **Database:** no migration; `source` values (`'osm'`/`'fsq'`) and `quality_source` unchanged.
- **OpenAPI / admin contract:** the `/admin/poi/*` DTOs reference the DB source codes (`'osm'`/`'fsq'`), not the env/config names, so `openapi:gen` stays **byte-identical** and the admin SPA / companion / mobile need zero changes.
- **Backward compatibility:** none. Pre-production, and the ops-enablement has not yet set any of these vars in Coolify, so there are zero live env vars to migrate — a clean break (consistent with the maintainer's "safe to break staging" call). The importers do NOT read the old names.

## Rollout & execution

- **One atomic PR.** The upload-dir env vars (`TARMOTO_OSM_POI_IMPORT_DIR` / `TARMOTO_FSQ_POI_IMPORT_DIR`) are read by BOTH `apps/backend` (the admin upload path) and `apps/ingest` (the import); they must rename in lockstep, so the change cannot be split across PRs without a broken intermediate state.
- **Task slicing** (each a green-gate checkpoint), built via `writing-plans` → `subagent-driven-development`. Both POI sources share the same files (`poi-import.config.ts`, `refresh-config.ts`, `import-pois.ts`), so they rename together in one pass rather than as separate tasks:
  1. **POI imports** (`poi`→`osm_poi`, `fsq`→`fsq_poi`): `packages/ingest` (refresh-config + regions env reads) + `apps/ingest` (config keys + interfaces-that-move, service, processor, scheduler, both refresh scripts, `import-pois`, internal service, tests). Keep `PoiImportConfig` + the `poi.import` queue + `PoiImportService` domain-named.
  2. **Backend cross-app env reads + Docker + compose:** `apps/backend` upload path (`TARMOTO_OSM_POI_IMPORT_DIR` / `TARMOTO_FSQ_POI_IMPORT_DIR`, `TARMOTO_FSQ_POI_TOKEN` if read there), both `Dockerfile`s, `infra/docker/docker-compose.yml`, `.env.example`s.
  3. **OSM-road + queue** (`osm`→`osm_road`, `osm.import`→`road.import`): `apps/backend/src/modules/roads/` (osm-import config/service/processor, quality-conflation) + `jobs.constants` + `queue-health` + tests.
  4. **Docs:** `runbook.md`, `data-sources-and-storage.md`, `architecture.md`, the roads/osm-import READMEs, ADRs that name the vars; and the ops-enablement checklist var names.
- **Per-task gates:** `pnpm --filter @tarmoto/ingest build`, `pnpm --filter @tarmoto/backend build`, `pnpm --filter @tarmoto/backend lint`, relevant `test`, and `pnpm openapi:gen` → `packages/openapi-client` byte-identical.

## Risks & validation

- **Missed env read = silent runtime break** (an importer reading a name nothing sets → disabled/500 with no compile error). Mitigation: after each task, `rg` for the OLD token across the repo to prove zero stragglers (excluding historical docs/specs that intentionally record the old name); the per-task review verifies this.
- **Missed queue-name string** → jobs never processed. Mitigation: `queue-health` registry + processor decorators + constants all reference the shared `ROAD_IMPORT` constant (no bare string literals); grep for `'osm.import'`.
- **`grep`-and-replace over-reach** into historical design docs/plan files that legitimately record the old names. Mitigation: task 5 curates docs deliberately; code tasks exclude `docs/superpowers/**`.
- **The `TARMOTO_FSQ_TOKEN` → `TARMOTO_FSQ_POI_TOKEN` rename** is the one "source-credential vs importer-env" judgment call (the Foursquare account token is source-level, not domain-specific). Chosen for a uniform `TARMOTO_FSQ_POI_` prefix; revisit if a second FSQ domain ever appears.

## Out of scope

- Generalising the road subsystem to a multi-source provider seam (road epic B/C) — the `road.import` domain queue is chosen to be _compatible_ with that future, but the seam itself is not built here.
- Any change to POI/road read paths, DTOs, or the admin UI.
