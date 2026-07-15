# `@tarmoto/ingest` Contract Hoist — Design

- **Date:** 2026-07-15
- **Status:** Approved (design); implementation plan pending
- **Scope:** **Phase 1** of extracting POI ingestion into a dedicated service so the backend becomes a pure consumer + admin gateway.

## Context & motivation

The offline data pipeline (fetch → filter → import → DB) currently lives inside `apps/backend`: the extract scripts (`refresh-poi-extracts`, `refresh-fsq-extracts`) run in a separate scheduled container but compile from the backend build, and the importer is a backend worker cron + admin UI (#971). The agreed end-state is a dedicated **`apps/ingest`** service that owns fetch+filter+import (+ a small internal API called only by the backend admin gateway), leaving the backend to serve POI reads (`PoiService` store-first + Overpass fallback) and proxy admin commands — with **zero import logic**.

Because this reshapes a live-on-staging pipeline, it's phased:

- **Phase 1 (this spec):** hoist the drift-sensitive, framework-free **ingestion contract** out of `apps/backend` into a new shared package `@tarmoto/ingest`. Zero behavior change — a pure import-path move — so it de-risks Phases 2–3.
- **Phase 2:** stand up `apps/ingest` owning the automated extract+import (the scheduled path moves off the worker; the service imports its own freshly-produced files).
- **Phase 3:** add the `apps/ingest` internal API, move the admin trigger to a backend proxy, slim the backend to pure consumer.

The contract must have one home so the backend importer **and** the future `apps/ingest` can't drift (the clip bboxes, the osmium tag set that must stay a superset of the importer's parser, the FSQ query fields that must match `FsqPlaceRow`, and the Geofabrik slugs). Today those constants sit next to `registerAs` configs in `poi-import.config.ts`, so importing them drags in `@nestjs/config`; `@tarmoto/shared` (which the frontends consume) is the wrong home because it would leak osmium/DuckDB internals into the mobile/companion bundles.

## Key decisions

1. **New package `@tarmoto/ingest`** — pure TypeScript, **zero runtime deps, zero `@nestjs`** (mirrors `@tarmoto/shared`). Domain-neutral name: the ingestion service is already slated to grow beyond POI (road-quality extract is deferred Sub-project B; hazards/closings are plausible future tenants), so `poi-ingest` would force a later rename.
2. **Organized by domain:** the POI contract lands under `src/poi/`; `roads/`, `hazards/`, `closings/` slot in as siblings later without a rename. The Phase-1 barrel just re-exports `poi/`.
3. **Phase 1 is config-contract only.** The import _logic_ (`poi-import-source`, `fsq-poi-categories`, `osm-poi-tags`), the **entities/migrations**, and `refresh-common` + the two `refresh-*.ts` scripts do **not** move (they re-point imports and physically relocate in Phase 2). Entity/migration ownership is coupled to _how_ `apps/ingest` writes the DB — Phase 2's core question — so locking it now would be premature.
4. **Zero behavior change** — verified by keeping every existing test green after only an import-path swap.

## Package layout

`packages/ingest/` (auto-included by the `packages/*` workspace glob):

```
packages/ingest/
  package.json         # name @tarmoto/ingest, "type":"module", exports ./dist/index.js,
                       # scripts: build (tsc) / test (jest) / lint; deps: {} (zero)
  tsconfig.json        # extends tsconfig.base.json (noUncheckedIndexedAccess etc.)
  jest.config.*        # mirrors packages/shared
  src/
    index.ts           # export * from './poi/index.js'
    poi/
      index.ts         # barrel for the POI contract
      regions.ts       # PoiImportRegion, DEFAULT_REGIONS, parseRegions
      refresh-config.ts# the whole former poi-refresh.config.ts (imports ./regions.js)
      regions.spec.ts        # the parseRegions/DEFAULT_REGIONS cases
      refresh-config.spec.ts # the former poi-refresh.config.spec
```

## What moves / stays / is deleted

**Moves into `@tarmoto/ingest/src/poi/` (verbatim, no logic edits):**

- From `apps/backend/src/modules/poi/poi-import.config.ts` → `regions.ts`: `PoiImportRegion` (interface), `DEFAULT_REGIONS`, `parseRegions`.
- From `apps/backend/src/modules/poi/poi-refresh.config.ts` → `refresh-config.ts` (**whole file**): `GEOFABRIK_BASE_URL`, `GEOFABRIK_SLUGS`, `POI_TAGS_FILTER_EXPRESSIONS`, `geofabrikUrl`, `bboxArg`, `PoiRefreshConfig`, `resolvePoiRefreshConfig`, `FSQ_CATALOG_ENDPOINT`, `FSQ_PLACES_TABLE`, `FSQ_CATEGORY_PREFILTER`, `FSQ_DUCKDB_MEMORY_LIMIT`, `FsqRefreshConfig`, `FsqExtractSqlParams`, `resolveFsqRefreshConfig`, `buildFsqExtractSql`.
- Their unit specs: `poi-refresh.config.spec.ts` wholesale; the `parseRegions`/`DEFAULT_REGIONS` cases split out of `poi-import.config.spec.ts`.

**Stays in `apps/backend/src/modules/poi/poi-import.config.ts`** (now much smaller): the `PoiImportConfig` interface + `poiImportConfig` / `fsqImportConfig` (`registerAs` — NestJS-coupled), which now `import { DEFAULT_REGIONS, parseRegions, type PoiImportRegion } from '@tarmoto/ingest'`. Its remaining spec keeps the `registerAs`-shape cases.

**Deleted from backend:** `apps/backend/src/modules/poi/poi-refresh.config.ts` (+ its spec — moved).

## Import rewire

The ~22 consumers of the moved symbols swap their import path to `@tarmoto/ingest` (the barrel). The registerAs configs are still imported from `poi-import.config.js`, so a file that uses both (e.g. the importer) imports the region contract from `@tarmoto/ingest` and the config token from `poi-import.config.js`. Known consumers:

- Importer: `poi-import.service.ts`, `poi-import-source.ts`, `poi-import-admin.service.ts`, `poi-database.module.ts`.
- Jobs: `jobs.producer.ts`, `processors/poi-import.processor.ts`.
- Scripts: `refresh-poi-extracts.ts`, `refresh-fsq-extracts.ts`, `load-region-boundaries.ts`, `derive-region-boundaries.mjs`.
- DB/migrations: `data-source.poi.ts`, `migrations-poi/1800000000000-AddPoiImportRegions.ts`.
- Specs mirroring the above.

`apps/backend/package.json` adds `"@tarmoto/ingest": "workspace:*"`.

## Build & Docker topology

- **Build order:** `@tarmoto/ingest` builds **before** `@tarmoto/backend` (same as `@tarmoto/shared`). The `openapi:gen` / build chain + CI gain an `ingest` build step (pnpm workspace topology orders `pnpm -r build`).
- **Docker — both backend-compiling images must build the new package** (or they fail to resolve the import at build time):
  - `apps/backend/Dockerfile`: COPY `packages/ingest/package.json` in the deps stage; `pnpm --filter @tarmoto/ingest build` before the backend build; COPY `packages/ingest/dist` into the runtime stage.
  - `apps/backend/Dockerfile.poi-refresh`: the same three additions — the `refresh-*.js` it runs now import from `@tarmoto/ingest`.

## Testing & zero-behavior-change guarantee

This is an import-path move with no logic edits; correctness is "every existing test still passes, now resolving to the package":

- The moved specs run in `@tarmoto/ingest` (jest, mirroring `@tarmoto/shared`).
- The full backend suite, the `refresh-poi/fsq-extracts` specs, `migration-registry.spec`, and `data-source.poi` all resolve to the package and stay green.
- The strict `openapi:gen` build (the `noUncheckedIndexedAccess` gate) passes.

**Verification gate:** `pnpm build` (topo order) → backend suite → refresh specs → strict `openapi:gen` → **both Docker images build locally** (the real check that the package is wired into each image).

## Rollout / risk

Pure refactor, pre-production, no runtime change. The only real footgun is forgetting one of the two Dockerfiles — caught by building both images in the gate. Everything else is a mechanical path swap that the compiler + existing tests verify. No migration, no contract change to OpenAPI/mobile/companion (the moved symbols are backend/extractor-internal).

## Out of scope / follow-ups

- **Phase 2** — `apps/ingest` service owning the automated extract+import; relocating `refresh-common` + `refresh-*.ts`; moving the import logic (`poi-import-source`, `fsq-poi-categories`, `osm-poi-tags`) into `@tarmoto/ingest`.
- **Phase 3** — the `apps/ingest` internal API + backend admin proxy + backend slimmed to pure consumer.
- **Cross-phase decision deferred to Phase 2:** where the POI entities (`Poi`, `poi_import_regions`, `poi_import_runs`) + migrations live once two apps touch the POI DB (shared entities/migrations package vs `apps/ingest` owns write-schema + backend thin read models).
- Road-quality (Sub-project B) + future hazards/closings extractors will add `src/roads/`, `src/hazards/`, `src/closings/` to `@tarmoto/ingest` when built.
