# 7. Separate PostgreSQL/PostGIS instance for POIs

Date: 2026-07-07

## Status

Accepted

## Context

The `pois` table is about to grow by two to three orders of magnitude. Today it
holds a single launch region (~2.3k rows for the CZ/Beskydy box). The real-data
pipeline (epic #847) fills it from OpenStreetMap: continent-scale ingestion
(#850, Geofabrik/osmium) plus an optional second bulk source (#869, Foursquare OS
Places). For our filtered kinds (food/fuel/lodging/viewpoints) across the target
coverage (Central Europe + Alps + Balkans) that is on the order of **millions of
rows ≈ several to ~15 GB** of measured on-disk cost (~885 B/row all-in, heap +
GiST/GIN indexes + toast), plus transient scratch during imports.

The current production Coolify Postgres volume does not have room for that, and
the bulk import is a heavy, bursty write workload that we do not want competing
with the app's transactional traffic for I/O, cache, and autovacuum.

Two facts make splitting `pois` out unusually safe:

- **`pois` is fully standalone.** The `Poi` entity has no relations, nothing
  foreign-keys to it, and `trip_waypoints` store _denormalized_ copies (their own
  geometry + name), not a FK to `pois`. No query joins `pois` to app tables. So
  moving it to another database breaks no cross-table join or referential
  integrity — the usual reason splitting a table out is painful does not apply.
- **POIs are a secondary feature.** Users, rides, and trips must keep working even
  if the POI store is unavailable. The store-backed read paths (`/poi/in-bbox`,
  `/poi/in-corridor`, `/poi/:id`) already return empty for un-imported regions;
  the live Overpass endpoints (`/poi/nearby`, `/poi/along-route`,
  `/poi/accommodations`) do not touch the database at all.

The store is empty in every environment today (the weekly importer has never been
enabled), so there is no production data to migrate — the cutover is essentially
free if we do it now, before the store is populated at scale.

## Decision

Move `pois` to its **own PostgreSQL 16 / PostGIS instance**, separate from the
app database, and give the backend a **second, resilient TypeORM connection**
for it.

### Topology

- A new PostGIS instance `tarmoto-poi-db` with its own disk, backups, and
  monitoring, independent of `tarmoto-db`.
- The backend keeps its default connection for every app entity and gains a
  second **named connection `'poi'`** holding only the `Poi` entity. `Poi` is
  removed from the default connection's `entities` list.
- `PoiModule` binds its repository to the `'poi'` connection
  (`TypeOrmModule.forFeature([Poi], 'poi')`); `PoiStoreService` and
  `PoiImportService` inject `@InjectRepository(Poi, 'poi')`.

### Resilience — the app tolerates the POI DB being down

A naive `TypeOrmModule.forRootAsync` for the second connection would crash
application boot if the POI database is unreachable after its retries, coupling
whole-app uptime to a secondary datastore. Instead the `'poi'` connection is wired
as a **custom resilient provider**:

- It attempts `initialize()` (running `'poi'` migrations) inside a guard; on
  failure it logs, leaves the DataSource uninitialized, and retries in the
  background with backoff. **Application boot never blocks or fails on the POI
  database.**
- `PoiStoreService` checks connection readiness and returns an explicit **503
  Service Unavailable** when the POI DB is not connected — never a silent empty
  result (per the repository's no-silent-failure rule). Callers can tell "no POIs
  here" (empty 200) apart from "POI store is down" (503).
- The live Overpass `/poi/*` endpoints are unaffected — they never touch the
  database.

### Configuration

New `TARMOTO_POI_DATABASE_{HOST,PORT,NAME,USER,PASSWORD}` variables (mirroring the
existing `TARMOTO_DATABASE_*`), surfaced through a `poiDatabaseConfig`
`registerAs`. Local development defaults point at the new Compose service.

### Migrations

The POI database gets its own migration lineage: a dedicated `src/migrations-poi/`
directory, a `data-source.poi.ts` CLI DataSource, and `db:migrate:poi` /
`db:revert:poi` scripts (plus root passthroughs). The two existing POI migrations
(`AddPois1787000000000`, `AddPoiDecisionSupportFields1793000000000`) **move**
there and are removed from the app database's chain in both `database.module.ts`
and `data-source.ts`.

A `DropPois` migration on the **app** database removes the now-orphaned `pois`
table so no dead table is left behind. This is safe: the table is empty in
production; a local dev database is re-populated with one `pnpm poi:import`.

### Provisioning

- **Local:** a new `tarmoto-poi-db` PostGIS service (+ named volume) in
  `infra/docker/docker-compose.yml`, on host port `5433` to avoid clashing with
  the app DB on `5432`.
- **Production:** a separate Coolify Postgres service, with the
  `TARMOTO_POI_DATABASE_*` variables set on the backend. This is where its larger
  disk lives.
- The `poi:import` CLI and the weekly import cron write to the `'poi'` connection.
  Continent-scale ingestion (#850) targets it too.

### Observability

A POI-database health indicator is added to the existing health surface, reported
as **degraded (non-fatal)** so an unavailable POI DB never flips the whole
application unhealthy.

## Consequences

**What changes**

- Two TypeORM connections in the backend and two migration lineages to run and
  keep in sync.
- A second database to provision, back up, and monitor in every environment.
- New env vars, a new Compose service, and a one-time app-DB `DropPois` migration.

**What does not change**

- The read/serve API shape (`/poi/*`), the companion planner, the mobile
  consumers, the generated OpenAPI client, and `@tarmoto/shared`. Only _where the
  rows live_ changes.
- The live Overpass endpoints and their availability.

**Operational posture**

- The app boots and serves all non-POI features even when the POI DB is absent —
  which also smooths rollout: the backend can ship before the POI instance is
  provisioned, with POI store reads returning 503 until it exists.
- The heavy #850/#869 bulk-import workload is isolated from app-DB I/O.

## Alternatives considered

- **Extend the existing `pgdata` volume and keep `pois` in the app DB.** Zero
  code, but gives no isolation: the app database carries the multi-GB POI bulk and
  the bursty import workload, and the two share a disk, cache, and autovacuum.
  Rejected — it does not address the workload-isolation goal and only defers the
  capacity question.
- **A separate database (schema) on the same Postgres instance.** Gives logical
  isolation and a second connection, but shares the same server and disk volume,
  so it does **not** solve the capacity constraint that motivated this. Rejected.
- **Hard-require the POI DB at boot** (treat it like the main DB). Simpler wiring,
  but couples whole-app uptime to a secondary datastore — a POI-DB blip would take
  down users/rides/trips. Rejected in favour of the resilient, tolerate-down
  wiring above.
