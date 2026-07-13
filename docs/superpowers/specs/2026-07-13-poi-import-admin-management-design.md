# POI Import Admin Management (Phase A) — Design

**Goal:** Let an operator import POIs for both bulk sources (OSM + FSQ OS) **entirely through the admin UI** — upload a pre-produced extract, trigger the import, and see per-region coverage, counts, extract state, and durable run history — with no SSH.

**Architecture:** A guarded `/admin/poi/*` controller over a POI-module service that (a) assembles per-`(source, region)` status from the POI DB + extract dir + the `poi.import` queue, (b) accepts an uploaded extract and writes it atomically into the source's extract dir, and (c) triggers an on-demand import by enqueuing the existing `POI_IMPORT_REGION` job. A new `poi_import_runs` table on the POI DB captures every run (cron **and** manual), written by the existing `PoiImportProcessor`. A new admin-SPA page renders it.

**Tech stack:** NestJS 11 + BullMQ + TypeORM (POI PostGIS datasource), the admin Vite SPA on `$api`/openapi-react-query.

---

## 1. Why this doc — and the building blocks that already exist

Today POI imports are a CLI/weekly-cron flow; there is **no UI**, no durable run record, and "is CZ imported and fresh?" is a raw SQL query. Phase A makes import an operable admin surface. Most of it is wiring, because the primitives exist:

- **Queue + trigger:** the `poi.import` BullMQ queue with a `POI_IMPORT_REGION` job (`{ code, source? }`, `PoiImportRegionJobData`). The region job **does not re-check** `TARMOTO_*_IMPORT_ENABLED`, so an admin trigger runs on demand even with the weekly cron off. Cross-module callers enqueue via `@InjectQueue(QUEUE_NAMES.POI_IMPORT)` (the `DataExportController` pattern; `JobsProducer` is in-module-only).
- **Run result shape:** `PoiImportService.importRegion()` returns `PoiImportResult { region, fetched, upserted, tombstoned, skipped }` — the columns of `poi_import_runs`.
- **Source registry:** `POI_IMPORT_SOURCES` is the array of importers; each exposes `.source` (`'osm'`/`'fsq'`), `.enabled`, `.regions` (configured `DEFAULT_REGIONS` subset), and its extract filename (`<code>.osm` / `<code>.fsq.jsonl`) resolved under its own dir (`TARMOTO_POI_IMPORT_DIR` / `TARMOTO_FSQ_IMPORT_DIR`).
- **Status data:** `poi_import_regions.imported_at` (coverage), and `pois` columns `source` + `import_region` (varchar 2) + `deactivated_at` for a per-region live count.
- **Admin platform:** `internal.guard` (admin-only) + `admin-audit.interceptor` + typed DTOs (mirror `admin-metrics.controller`); admin served prefix-less at `/admin/*`.

## 2. Scope

**In (Phase A), for every configured `(source, region)` across OSM + FSQ OS:**

- View: coverage (`imported_at`), live `pois` count, extract file `{present, size, mtime}`, last run result, and live queue state (`idle`/`queued`/`running`).
- **Upload** a pre-produced extract file → stored in the source's extract dir.
- **Trigger** an import (two-step: separate from upload).
- Durable **run history** that makes silent wipe-guard skips visible.

**Out (deferred, seams left open):** server-side download/produce (Phase B, OSM-only), deleting/replacing extracts beyond re-upload, editing region config/bboxes, a `load-boundaries` button, schedule editing, any FSQ token handling. The operator still **produces** the filtered extract offline (osmium/DuckDB); Phase A only removes the file-placement + trigger + visibility steps from the shell.

## 3. Architecture & components

- **`AdminPoiController`** (`apps/backend/src/modules/admin/`, or an `admin/poi/` submodule) — `/admin/poi/*`, `@UseGuards(InternalGuard)` + audit interceptor. Thin HTTP layer; delegates to the service. DTOs are typed so the admin `$api` client picks them up.
- **`PoiImportAdminService`** (POI module, so POI-DB access stays there) —
  - `listRegionStatus()`: enumerate `POI_IMPORT_SOURCES` → per `(source, region)` assemble status (below).
  - `storeExtract(source, code, stream)`: resolve `<dir>/<filename>` from the importer, atomic write.
  - `triggerImport(source, code)`: enqueue `POI_IMPORT_REGION { code, source, trigger:'manual' }` via `@InjectQueue`.
  - `listRuns(filter)`: read `poi_import_runs`.
- **`poi_import_runs`** table + `PoiImportRun` entity on the **POI DB** — new migration under `apps/backend/src/migrations-poi/`, entity + migration registered in `poi-database.module.ts` (its own `entities`/`migrations` arrays, not the main DB's).
- **Run recording** — the existing **`PoiImportProcessor`** (single execution point for cron + manual) wraps `importRegion` with a `PoiImportRunRecorder` (POI module, POI datasource): insert `running` → on return update `success`/`skipped`(+reason) → on throw update `failed`(+error) and rethrow (BullMQ still retries). `trigger` comes from the job payload.
- **Admin SPA** (`apps/admin/`) — one new **POI Imports** page, typed via `$api`/openapi-react-query, following existing admin pages.

**Status assembly** for one `(source, region)`:

- `imported_at` ← `poi_import_regions` (coverage; OSM-stamped only — FSQ rows show coverage as N/A by design).
- `poi_count` ← `COUNT(*) FROM pois WHERE source=$1 AND import_region=$2 AND deactivated_at IS NULL`.
- `extract` ← `fs.stat` of the importer's resolved `<dir>/<filename>` → `{present, size_bytes, modified_at}` or `null`.
- `last_run` ← latest `poi_import_runs` row for `(source, code)`.
- `live_state` ← BullMQ: look up the deterministic manual jobId (below) in `waiting`/`active`/`delayed` → `queued`/`running`, else `idle`.

## 4. Data model — `poi_import_runs` (POI DB)

| column        | type              | notes                                        |
| ------------- | ----------------- | -------------------------------------------- |
| `id`          | bigserial pk      | append-only log, ordered by id               |
| `source`      | varchar(32)       | `osm` / `fsq`                                |
| `region_code` | varchar(2)        | ISO-2                                        |
| `status`      | varchar(16)       | `running` / `success` / `skipped` / `failed` |
| `trigger`     | varchar(16)       | `manual` / `cron`                            |
| `fetched`     | int null          | from `PoiImportResult`                       |
| `upserted`    | int null          |                                              |
| `tombstoned`  | int null          |                                              |
| `skip_reason` | text null         | why the wipe-guard/no-extract skipped        |
| `error`       | text null         | failure message (truncated)                  |
| `job_id`      | varchar(200) null | BullMQ id, to correlate live state           |
| `started_at`  | timestamptz       | default now()                                |
| `finished_at` | timestamptz null  |                                              |

Index `(region_code, source, started_at DESC)` → cheap "latest run per region." One row per job **execution attempt** (so retries are visible history). Retention is out of scope for Phase A (low volume); a later prune job can cap it.

## 5. API endpoints (`/admin/poi/*`, admin-guarded, typed DTOs)

- `GET /admin/poi/regions` → `RegionImportStatusDto[]`, one per `(source, code)`:
  `{ source, code, configured: boolean, imported_at: string|null, poi_count: number, extract: { present, size_bytes, modified_at }|null, last_run: RunDto|null, live_state: 'idle'|'queued'|'running' }`. The UI groups by `code`.
- `POST /admin/poi/regions/:source/:code/extract` — **multipart** upload; streams to `<dir>/<filename>.part` → fsync → atomic `rename`. Returns the new `extract` stat. Rejects unknown `source`/`code`, wrong extension for the source, or size over cap.
- `POST /admin/poi/regions/:source/:code/import` → enqueue `POI_IMPORT_REGION`; returns `{ job_id, status: 'queued' }`. **409** if a run is already in flight for `(source, code)`.
- `GET /admin/poi/runs?source=&code=&limit=` → `RunDto[]`, newest first.

DTOs live in the admin module's `dto/` and are emitted to the OpenAPI spec (admin `$api`) — the new endpoints therefore require a `postman:gen`/OpenAPI regen step (per the admin CI/contract convention).

## 6. Upload → import flow

1. **Upload** (validated: `source∈{osm,fsq}`, `code∈importer.regions`, extension matches the source's filename, `size ≤ TARMOTO_POI_UPLOAD_MAX_BYTES` default 200 MB) → stream to a sibling temp file in the same dir → `fsync` → atomic `rename` onto the importer's target filename. Atomic rename guarantees a half-uploaded file is never importable, and re-upload replaces in place.
2. **Import** (separate action) → `triggerImport` enqueues `POI_IMPORT_REGION { code, source, trigger:'manual' }`. The processor: create `poi_import_runs` row `running` → `importRegion(region)` → update `success`(counts)/`skipped`(reason) → on error update `failed`(error) + rethrow. The **wipe-guard is unchanged** — a 0-row/too-small extract still degrades to `skipped`, now visibly in history.

**Wire-contract change:** add optional `trigger?: 'manual' | 'cron'` to `PoiImportRegionJobData` (default `cron` for legacy/dispatcher jobs); the dispatcher may set `'cron'` explicitly. This is the only change to existing job code.

## 7. Concurrency & safety

- **Manual vs manual:** the manual jobId is **deterministic per `(source, code)`** (e.g. `import-region_manual_<source>_<code>`, colons stripped per BullMQ). BullMQ dedups, so a double-click collapses to one job; the endpoint returns **409** when an active/queued run exists.
- **Manual vs cron (real hazard):** admin triggers can now overlap the weekly dispatcher for the same region → two concurrent upsert+tombstone passes racing on `pois`. Guard `importRegion` with a **PostgreSQL advisory lock** keyed on a hash of `(source, code)`, **try-acquire (non-blocking)**: the job that holds it imports; a job that can't acquire it **fails fast** with a "region import already running" error and BullMQ retries after backoff (so it never races, and never blocks a worker slot waiting). The lock is released when the import finishes (or its connection drops). (Cron-vs-cron already can't overlap — the dispatcher staggers and dedups.)
- **Auth/audit:** admin-only via `internal.guard`; upload + import are audited side-effects.
- **Upload robustness:** size cap; disk-full/rename errors surfaced as 5xx with a clear message; the `.part` temp is cleaned on failure.
- **Worker dependency:** imports run on the **worker** process. If none is up, jobs sit `queued`; the page shows that state (surfaced via the existing `queue-health` service) rather than implying success.
- **POI DB down:** status endpoints surface "store unavailable" (the resilient POI datasource already distinguishes outage from bug); the page degrades, doesn't crash.

## 8. Admin UI (POI Imports page)

- A table of configured regions (rows) with an **OSM** and an **FSQ** cell each, showing: coverage badge (`imported_at` / "not covered"), `poi_count`, extract chip (`present` + `modified_at`, or "no extract"), a live-state chip (`idle`/`queued`/`running`), and the last-run summary (`✓ upserted N` / `⤼ skipped: reason` / `✗ failed`).
- Per cell: an **Upload** control (file picker → multipart) and an **Import** button (disabled while `queued`/`running`, or when no extract is present).
- A **Runs** panel below: recent `poi_import_runs` (region, source, trigger, status, counts, timestamps).
- Data via `$api` react-query with a refetch interval so `queued`/`running` and fresh results appear without reload. Upload is the one multipart (non-JSON) call.

## 9. Testing

- **Unit (service):** status assembly (counts/extract-stat/last-run/live-state), atomic upload (temp→rename, cleanup on failure, size/extension/source validation), `triggerImport` dedup + 409, run-recorder transitions (running→success/skipped/failed).
- **Unit (processor):** writes the run row for success, skip (wipe-guard), and failure (+rethrow); reads `trigger` from payload; legacy payload defaults `cron`.
- **Controller:** guard enforcement (401/403 unauth), validation (bad source/code/oversize), audit invocation.
- **Migration:** `poi_import_runs` up/down.
- **POI-DB-backed check** (gated like the existing POI e2e): upload → import → run row recorded → `GET /regions` reflects new `imported_at`/count.
- **Advisory-lock test:** two concurrent `importRegion` calls for one region serialize (needs real PG).

## 10. Extension path (to "all actions")

The same page + controller + `poi_import_runs` + queue-state pattern absorb later actions with no rework: **Phase B** "Fetch from Geofabrik" (a produce job that lands an extract, then the existing import flow), replace/delete extract, edit region config/bbox, a `load-boundaries` button, and re-schedule controls. Each is a new action row/button and (if long-running) a new job that records into the same runs table.

## 11. Assumptions & notes

- The operator still produces the filtered extract offline; a committed `build-poi-extract.sh` (separate follow-up) makes that a one-liner. Phase A does not download or run osmium/DuckDB server-side.
- FSQ coverage (`imported_at`) is intentionally never stamped (OSM-only, per the coverage design); the FSQ cell shows count + extract + runs, and "coverage: OSM-only" rather than a misleading badge.
- `poi_count` uses `import_region`; rows imported before `import_region` existed (if any legacy seed) count as unowned and won't attribute to a region until re-imported — acceptable, and re-import fixes it.
- Upload max size is configurable (`TARMOTO_POI_UPLOAD_MAX_BYTES`, default 200 MB); filtered+clipped extracts are well under this.
