# `apps/ingest` Internal API + Backend Proxy — Design

- **Date:** 2026-07-16
- **Status:** Approved (design); implementation plan pending
- **Scope:** **Phase 3 (final)** of extracting POI ingestion into a dedicated service. Builds on Phase 1 (`@tarmoto/ingest` contract hoist, #1001) + Phase 2 (`apps/ingest` service, #1007).

## Context & motivation

Phase 2 moved the POI import engine into `apps/ingest` and left the **seam** between the two apps as the shared BullMQ `poi.import` queue: the backend admin front-door **enqueues** an `import-region` job (via `@InjectQueue`), and `apps/ingest`'s worker consumes it. The backend admin also still **reads the POI DB directly** for its coverage/run views and enumerates all 17×2 `(source, region)` pairs from `DEFAULT_REGIONS` — which cannot see `apps/ingest`'s per-source enablement config, so it advertises pairs the worker isn't configured for (Phase 2 handles that with a graceful skip; the real fix is deferred here).

Phase 3 replaces the queue seam with a small **HTTP internal API** on `apps/ingest` (server-to-server, **not** internet-exposed — called only by the backend), turns the backend admin into a **thin proxy**, and drops the backend's `poi.import` queue client entirely. `apps/ingest` becomes the single owner of the import config, the queue, and the admin-status data; the backend is a POI **reader** (`PoiService`) + an **admin gateway** (proxy + receive-uploads→shared-volume).

## Key decisions (approved)

1. **The seam becomes an HTTP internal API on `apps/ingest`**, guarded by a shared `x-internal-token` (mirrors the existing admin-worker→backend `InternalGuard` pattern). Reachable only from the backend, server-to-server — not internet-exposed.
2. **Uploads stay `admin → backend → shared volume` (Option A, unchanged).** The large (≤200 MB) multipart extract upload keeps hitting the backend, which writes it to the shared `/data/poi-extracts` volume that `apps/ingest` reads. The backend + ingest already share that volume, so re-streaming the file through an API (or exposing ingest at the edge) buys nothing. Only the small JSON calls move to the API.
3. **The admin coverage/runs come _entirely_ from the API**, not backend POI-DB reads — the backend admin becomes a genuine pass-through. `apps/ingest` owns the config + queue + POI write-schema, so it is the one place that can compute the whole coverage table. The backend keeps its POI-DB **read** connection for `PoiService`/`PoiStoreService` (the map/planner path) — unchanged.
4. **The enablement view ships in Phase 3.** `/internal/poi/regions` returns the real enabled `(source, code)` set, so the admin hides (and the trigger `400`s) unconfigured pairs — replacing Phase 2's "advertise all 34 + graceful skip." The worker's graceful skip stays as defence-in-depth against a stale queued job.

## The internal API (`apps/ingest`)

A new guarded controller on `apps/ingest`'s existing HTTP listener (which already serves the open `/healthz`). All routes under `/internal/poi/*`, behind an `InternalGuard` that checks `x-internal-token` against `TARMOTO_INTERNAL_API_TOKEN`; a missing/wrong token → `401`. (`/healthz` stays open for the container healthcheck.)

- **`POST /internal/poi/import`** — body `{ source, code, trigger }`. Validates the pair is enabled for that source (else `400`), then enqueues an `import-region` job onto `apps/ingest`'s own `poi.import` queue (the existing `PoiImportProducer`), returning the accepted job/run identifier. This is the direct replacement for the backend's old `@InjectQueue(...).add(...)`.
- **`GET /internal/poi/regions`** — the full coverage table the admin renders: per enabled `(source, code)`, the `enabled` flag, boundary presence + `imported_at`, `pois` count, last run summary, and live queue state (queued/active). Computed by `apps/ingest` from `poiImportConfig`/`fsqImportConfig` (enablement) + its POI-DB reads (`poi_import_regions`, `pois`, `poi_import_runs`) + its own queue.
- **`GET /internal/poi/runs`** — run history (from `poi_import_runs`), for the admin's run-history view.

The internal API's request/response DTOs are shaped so the backend admin controller can return them (or a trivial mapping) **without changing the existing `/admin/poi/*` response contract** — so the admin SPA's generated client is unaffected (fewer rows when pairs are disabled, but the same shape).

## Backend: admin becomes a thin proxy

`PoiImportAdminService` is reworked from a queue-producer + POI-DB-reader into an **HTTP client** of the internal API:

- **Trigger** (`POST /admin/poi/regions/:source/:code/import`) → `POST /internal/poi/import`; propagate the API's `400` for an unconfigured pair.
- **Coverage** (`GET /admin/poi/regions`) → `GET /internal/poi/regions`.
- **Runs** (`GET /admin/poi/runs`) → `GET /internal/poi/runs`.
- **Drops:** `@InjectQueue('poi.import')` + the queue live-state reads; the direct POI-DB reads for the admin view (`poi_import_regions`/`pois`/`poi_import_runs`); the local `SOURCE_STRATEGIES`/`DEFAULT_REGIONS` enumeration (Phase 2's decoupling shim) — all now sourced from the API.
- **Keeps (unchanged, Option A):** the upload path — `AdminPoiController`'s `POST …/extract`, `PoiUploadLockInterceptor`, and `storeExtract`→shared volume. The upload still lands on the shared volume; the subsequent import is triggered via the API.

**The backend drops the `poi.import` queue registration entirely** — `JobsModule`/`jobs.constants` no longer register or reference that queue; the queue lives wholly inside `apps/ingest`. The backend keeps its other queues (email, digest, …).

**Stays:** `PoiService`/`PoiStoreService` + the POI-DB **read** connection (the map/planner POI reads) — untouched. This is the backend's remaining POI role: a reader.

## Auth, config, transport

- **Shared token:** `TARMOTO_INTERNAL_API_TOKEN` on both apps (a secret). `apps/ingest`'s `InternalGuard` checks it; the backend's HTTP client sends it as `x-internal-token`.
- **Backend → ingest URL:** `TARMOTO_INGEST_INTERNAL_URL` (e.g. the ingest service's internal/server-to-server address). The backend's admin HTTP client targets `<url>/internal/poi/*`.
- **Transport:** plain `fetch`/`HttpModule` server-to-server; small JSON payloads. No new public surface.
- `apps/ingest` is NOT internet-exposed for `/internal/*` (only the backend, inside the infra, calls it). `/healthz` remains the only externally-hit route (the container healthcheck).

## Contract impact

- **Public/admin OpenAPI: unchanged.** No `/admin/poi/*` response DTO changes (the proxy returns the existing shapes). The admin SPA's generated client is unaffected. The internal API is server-to-server and **not** part of the exported OpenAPI. Strict `openapi:gen` stays byte-identical.
- **No mobile/companion impact** (POI reads are unchanged).

## Testing

- **`apps/ingest`:** unit tests for the `InternalGuard` (token accept/reject), the coverage/runs computation, and the import endpoint's enablement `400`; an e2e that `POST /internal/poi/import` enqueues (worker-off) + `GET /internal/poi/regions` returns the coverage for a seeded region — reusing Phase 2's synthetic-region, DB-safe fixture pattern.
- **Backend:** `PoiImportAdminService` tests now mock the HTTP client (not the queue/DB) and assert the proxy maps requests/responses + propagates the `400`; the admin controller e2e stays green against the mocked internal API. The upload path tests are unchanged.
- **Contract:** strict `openapi:gen` byte-identical (no admin DTO change); the `poi.import` queue no longer appears in the backend's queue registry (a guard/assertion update).
- Full backend suite + `apps/ingest` suite green.

## Rollout / risk

Pre-production/test phase; breaking changes allowed. This completes the cutover, so it pairs with the Phase-2 ops-enablement (provision the Coolify `apps/ingest` app + `INGEST_URL`/`COOLIFY_INGEST_UUID`).

- **New required config:** `TARMOTO_INTERNAL_API_TOKEN` (both apps) + `TARMOTO_INGEST_INTERNAL_URL` (backend). Without them the admin trigger/coverage/runs fail (the upload path still works — it's local). Documented in the runbook.
- **Deploy order unchanged:** `apps/ingest` first (now also serving the internal API), then the backend (which now depends on the API for admin). Until both are up + configured, the admin management page degrades (trigger/coverage error), but POI reads + the scheduled import are unaffected.
- **The queue moves fully inside `apps/ingest`** — the backend stops producing `poi.import`. A stale job enqueued by an old backend before cutover is still consumed by `apps/ingest` (same queue name/Redis); the worker's enablement skip guards an unconfigured stale job.

## Out of scope / follow-ups

- Uploads via the API / exposing `apps/ingest` at the edge (Option B/C) — explicitly rejected; the shared-volume drop stays.
- The Phase-2 ops-enablement (Coolify ingest app + `INGEST_URL`/`COOLIFY_INGEST_UUID` + `ingest-deploy.yml`) — an ops step this phase assumes.
- A superseding ADR for ADR-0007 (backend no longer owns POI migrations — from Phase 2).
- Road-quality Sub-project B + hazards/closings extractors as future `apps/ingest` tenants.
