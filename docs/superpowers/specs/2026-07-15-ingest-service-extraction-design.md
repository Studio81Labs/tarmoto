# `apps/ingest` Service Extraction — Design

- **Date:** 2026-07-15
- **Status:** Approved (design); implementation plan pending
- **Scope:** **Phase 2** of extracting POI ingestion into a dedicated service. Builds on Phase 1 (`@tarmoto/ingest` contract hoist, PR #1001, merged).

## Context & motivation

Today the POI/FSQ **write path** lives inside `apps/backend`, split awkwardly across three runtimes:

- **Extract** (produce `<code>.osm` / `<code>.fsq.jsonl`): three already-framework-free scripts in `apps/backend/src/scripts/` (`refresh-poi-extracts.ts`, `refresh-fsq-extracts.ts`, `refresh-common.ts`) that import only `@tarmoto/ingest`, touch no DB, shell out to osmium/duckdb, and run in a **scheduled Coolify container that compiles the entire backend** just to run two CLIs.
- **Import** (extract file → `pois`): `PoiImportService` + the pure mappers, run by a **BullMQ weekly cron in the backend worker** and by the **admin on-demand path** (#971).
- **POI DB**: a **separate** PostGIS database (the `'poi'` DataSource, ADR-0007), whose migrations the **backend runtime** runs at boot (`PoiDatabaseModule.migrationsRun`).

Phase 2 stands up a dedicated NestJS **`apps/ingest`** service that owns the whole automated write path (extract + scheduled import) and the POI-DB schema, leaving the backend as a **reader + a thin admin front-door**. Phase 3 later formalizes an HTTP internal API over the seam and finishes slimming the backend to a pure consumer.

The map that grounds this design: the **extract** half is already standalone (a physical move), but the **import** half is deeply NestJS/TypeORM-DI-coupled and has **two live callers** (the scheduled cron _and_ the admin path, which stays on the backend until Phase 3). So the import cannot merely move — the two apps must share a schema and meet at a seam.

## Key decisions (approved)

1. **The seam is the existing BullMQ `poi.import` queue.** The admin "trigger import" path _already_ only enqueues an `import-region` job — it never imports synchronously. So the import engine (service + processor + scheduler + recorder) moves **wholly** to `apps/ingest`; the backend keeps only the queue **client** (enqueue) + status reads. Backend enqueues, `apps/ingest` processes, over the shared Redis + shared `/data/poi-extracts` volume. **No import logic remains in the backend.**
2. **`apps/ingest` is a NestJS app.** Stack consistency; it reuses `PoiImportService` (DI), the `'poi'` TypeORM DataSource, and the BullMQ processor/scheduler almost as-is rather than porting the DB-coupled import core out of DI by hand.
3. **`apps/ingest` owns the POI-DB schema.** A new **`packages/poi-db`** package holds the TypeORM entities + migrations + DataSource factory; `apps/ingest` runs `migrationsRun`; the backend flips to `migrationsRun: false` and consumes the entities **read-only**. This matches the Phase 3 end-state (backend = pure consumer).
4. **One coherent deliverable, sliced into many small tasks.** The pipeline only works once all parts land, so it is one spec — but the plan decomposes it into independently-reviewable, green-tests tasks.

## Package / app topology (after Phase 2)

```
packages/
  ingest/        @tarmoto/ingest  — grows: absorbs the PURE import mappers/parsers
                 (osm-poi-tags, fsq-poi-categories, poi-extract-source,
                 poi-import-source, poi-import.lock). Still Nest-free / DB-free.
                 Gains a @tarmoto/shared dep (both pure).
  poi-db/        @tarmoto/poi-db  — NEW, TypeORM-aware: Poi + PoiImportRun entities,
                 migrations-poi/*, the poi_import_regions DDL + boundary loader,
                 and the 'poi' DataSource factory. Consumed by backend (read) and
                 apps/ingest (write + migrationsRun).
apps/
  ingest/        @tarmoto/ingest-service (NestJS) — NEW: extract + scheduled import
                 + admin-enqueued import processing + POI migrations.
  backend/       slimmed: POI reads + admin front-door only.
```

Note the two package names are distinct: **`@tarmoto/ingest`** is the pure contract/logic library (Phase 1), **`@tarmoto/poi-db`** is the TypeORM schema package (new). The app takes an internal name (e.g. `@tarmoto/ingest-service`) to avoid colliding with the library package name.

## What moves / stays / is deleted

**Moves into `@tarmoto/ingest`** (pure, no logic edits — same guarantee as Phase 1):

- `apps/backend/src/modules/poi/providers/osm-poi-tags.ts`, `fsq-poi-categories.ts`, `poi-extract-source.ts` (`parsePoiExtract`, sax reader), `poi-import-source.ts` (`OsmPoiImportSource`/`FsqPoiImportSource` plain classes + `PoiImportSource` interface), `poi-import.lock.ts` (`poiAdvisoryLockKey`). These are already Nest/DB-free.

**Moves into `@tarmoto/poi-db`** (new package):

- Entities `apps/backend/src/entities/poi.entity.ts` (`Poi`) + `poi-import-run.entity.ts` (`PoiImportRun`).
- `apps/backend/src/database/data-source.poi.ts` + `config/poi-database.config.ts` (as a DataSource factory).
- `apps/backend/src/database/migrations-poi/*` (all 8), including the `poi_import_regions` plain-table DDL. (`poi_import_regions` has **no** entity — it stays a raw table; the package exposes its DDL via the migration + the read/write raw-SQL helpers stay with their callers.)
- `apps/backend/src/scripts/load-region-boundaries.ts` (boundary loader) + the GeoJSON asset.

**Moves into `apps/ingest`** (the NestJS write engine):

- Extract scripts + `refresh-common.ts` (from `apps/backend/src/scripts/`).
- `PoiImportService` (`poi-import.service.ts`), `PoiImportRunRecorder` (`poi-import-run.recorder.ts`), `processors/poi-import.processor.ts`, the `poi.import` **scheduler** registration (from `jobs.scheduler.ts`), and the `import-pois` CLI.
- The `poiImportConfig` / `fsqImportConfig` (`registerAs`) import/refresh config (regions, enabled flags, dirs) — this is the ingestion service's config now.

**Stays in `apps/backend`** (reader + admin front-door):

- `PoiService` (`poi.service.ts`), `PoiStoreService` (`poi-store.service.ts`), `poi-repo.ts`/`withPoiRepo`, `poi-dedup.ts`, `poi-geo.ts` — all read-only; now import `Poi` from `@tarmoto/poi-db`.
- Admin: `admin-poi.controller.ts`, `poi-upload-lock.interceptor.ts`, and a **slimmed** `PoiImportAdminService` reduced to **enqueue + status-read + upload→volume** (no import logic).
- A BullMQ **queue client** for `poi.import` (producer only). The `poi.import` **queue name + job names** move from `jobs.constants.ts` into `@tarmoto/ingest`, since both apps now reference them (backend enqueues, `apps/ingest` processes); the backend's other queue constants (email, digest, …) stay in `jobs.constants.ts`.

**Deleted from `apps/backend`:** the `poi.import` **processor** + **scheduler** wiring, `PoiImportService` and its providers, `PoiImportRunRecorder`, the moved mappers/entities/migrations/CLI, and POI `migrationsRun` (backend no longer migrates the POI DB).

## The seam + admin flow (after)

```
Operator upload ─▶ backend AdminPoiController (auth + upload-lock)
                     └─▶ write <code>.osm/.fsq.jsonl to /data/poi-extracts (shared volume)
                     └─▶ enqueue poi.import 'import-region' {source,code,trigger:'manual'}
                                        │  (shared Redis)
Weekly scheduler (apps/ingest) ─────────┤
                                        ▼
                     apps/ingest PoiImportProcessor
                       └─▶ PoiImportService.importRegion  (pg_try_advisory_lock serializes
                            manual vs cron) → upsert pois + tombstone + stamp imported_at
                       └─▶ PoiImportRunRecorder → poi_import_runs
```

Both the manual and scheduled imports now execute **in `apps/ingest`'s processor**, so the existing `pg_try_advisory_lock(source, code)` serialization keeps working (it runs in one process). The backend's admin `listRegionStatus` reads its coverage/queue view from the **POI DB** (`poi_import_regions`, `pois` counts, `poi_import_runs`) + the queue's live job state + the canonical region list from `@tarmoto/ingest` — it no longer needs the ingestion service's private env config. (Any residual "which sources are enabled per code" that the admin view wants is a small read best served by Phase 3's internal API; for Phase 2 the admin shows regions present in the DB + queue.)

## Schema ownership & migration cutover

- `@tarmoto/poi-db` is the single home of the entities + migration list (removing today's **duplication** between `poi-database.module.ts` and `data-source.poi.ts` — one array, imported by both the runtime module and the CLI DataSource).
- `apps/ingest`'s `PoiDatabaseModule` boots with `migrationsRun: true`; the backend's flips to `migrationsRun: false` and stays tolerant of a schema that is **ahead** (reads only).
- **Cutover order** (pre-production, breaking changes allowed — no zero-downtime dance): deploy `apps/ingest` first so it applies any pending POI migrations, then deploy the slimmed backend. The `poi:load-boundaries` step (still a required pre-first-import operation) runs from `apps/ingest` now.

## Runtime & deployment topology

`apps/ingest` is **one container that replaces both** today's refresh container _and_ the backend worker's poi-import role:

- Debian base carrying **osmium + duckdb** (as `Dockerfile.poi-refresh` does today) **plus** the compiled NestJS app.
- The Nest process runs the **BullMQ worker** (`poi.import` processor) + the **weekly scheduler** — always-on.
- The **heavy extract** stays a **Coolify scheduled `docker exec`** of the relocated `refresh-*.js` (osmium streams multi-GB country PBFs — a one-shot CMD would restart-loop and re-download; keep it out of the always-on process), writing to the shared `/data/poi-extracts` volume.
- Shares Redis (queue) + the extract volume with the backend, as today. Deploys via the same Coolify-API mechanism as the backend (CI-triggered, auto-deploy off).
- The backend worker keeps its **other** queues (email, digest, …) — only the `poi.import` processor + schedule leave.

`Dockerfile.poi-refresh` is retired; its osmium/duckdb provisioning + uid/gid (100/101, matching the shared-volume owner) fold into `apps/ingest`'s Dockerfile.

## Scheduled import model

Keep the current **decoupled** model: extract (Coolify weekly, Sat) produces files; the `poi.import` weekly cron (Sun) imports the latest on-disk files — a timing offset, not a code dependency. This minimizes behavior change. Chaining extract→import (enqueue on successful produce) is noted as a **later enhancement**, not built here.

## Build / CI / deploy wiring

- Build order: `@tarmoto/shared` + `@tarmoto/ingest` → `@tarmoto/poi-db` → (`@tarmoto/backend`, `@tarmoto/ingest-service`). The Phase-1 `ingest:build` composites that build the backend now also build `poi-db`; the POI-owning scripts (`poi:import`, `fsq:import`, `poi:load-boundaries`, `db:migrate:poi`) repoint from the backend to `apps/ingest`.
- New `apps/ingest` Docker image + a `.github/workflows/ingest-*.yml` CI + deploy pair (mirroring backend). Path filters: `apps/ingest/**`, `packages/ingest/**`, `packages/poi-db/**`, `packages/shared/**`. The backend CI/deploy path filters gain `packages/poi-db/**` and drop nothing (they already gained `packages/ingest/**` in Phase 1).
- `packages-ci.yml` already covers new packages via `packages/**`.

## Testing & zero-behavior-change strategy

The moved units keep their tests, now resolving to the new homes (pure mappers → `@tarmoto/ingest`; entities/migrations → `@tarmoto/poi-db`; import service/processor → `apps/ingest`). Plus:

- A **real-PG import e2e in `apps/ingest`**: seed a small extract → run `importRegion` → assert `pois` upsert + tombstone + `poi_import_regions.imported_at`.
- The **backend suite stays green minus the deleted import pieces**; its POI **read** tests (PoiService/PoiStore) now resolve `Poi` from `@tarmoto/poi-db`.
- **Migration parity**: `migration-registry`-style guard for the POI migration list in its new single home; `pnpm db:migrate:poi` runs from `apps/ingest`.
- Strict `openapi:gen` stays clean and **byte-identical** — no controller/DTO changed, so the OpenAPI contract and all generated clients are unaffected.

## Rollout / risk

Pre-production/test phase; breaking changes allowed; the road subsystem is untouched and stays dormant.

- **Biggest risk — the migration-ownership flip.** If both apps ran `migrationsRun` they could race; the cutover makes `apps/ingest` the sole migrator and the backend tolerant-reader. Mitigated by deploy order (ingest first) and by the backend never writing the POI schema.
- **Queue cross-app**: `apps/ingest` must connect to the same Redis + register the `poi.import` **Worker** while the backend registers only the **Queue** (producer). Standard BullMQ; verified by the import e2e enqueuing from a backend-shaped producer.
- **Shared-volume contract** (upload path on backend, read on ingest) is unchanged — same mount, same atomic temp+rename suffixes (`.part` admin vs `.refresh.part` scheduled stay distinct).
- **Operational**: one new deployable + one retired container; the `poi:load-boundaries` pre-first-import step moves owners. Documented in the runbook update shipped with the change.

## Out of scope / follow-ups

- **Phase 3** — an `apps/ingest` **HTTP internal API** (server-to-server, not internet-exposed) replacing the queue-as-seam for admin triggers; the backend admin path becomes a pure **proxy**; the backend loses even the `poi.import` queue client. The Phase-2 seam is deliberately the existing queue so Phase 3 is an additive formalization.
- **Extract→import chaining** (enqueue import on successful produce).
- **Road-quality Sub-project B / hazards / closings** extractors — future `src/roads/`, `src/hazards/` tenants of `@tarmoto/ingest` + `apps/ingest`.
- Admin per-source enablement view served by the Phase-3 internal API rather than inferred from the DB/queue.
