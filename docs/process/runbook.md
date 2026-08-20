# Tarmoto operations runbook

Day-2 procedures for running Tarmoto's deployed surfaces (backend PaaS + Cloudflare).

## Deploys

Two environments per service (staging + production). Both are driven **entirely by CI** through the authenticated Coolify API — Coolify "Auto Deploy" is **OFF** on both applications, so a push never deploys via the PaaS GitHub App. What separates the environments is the **trigger ref** and the **env-scoped GitHub configuration**, not any PaaS toggle.

|                            | Staging                                                                                                                               | Production                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Trigger                    | push to `main`                                                                                                                        | push tag `v*`                       |
| GitHub Environment         | `staging`                                                                                                                             | `production`                        |
| Coolify "Auto Deploy"      | **OFF**                                                                                                                               | **OFF**                             |
| How CI deploys             | authenticated Coolify deploy API (`GET {COOLIFY_API_BASE_URL}/api/v1/deploy?uuid=<COOLIFY_BACKEND_UUID>`, `Bearer COOLIFY_API_TOKEN`) | same call, `production`-scoped UUID |
| Healthcheck + smoke target | `api-staging.tarmoto.app`                                                                                                             | `api.tarmoto.app`                   |

`workflow_dispatch` on the **`Deploy`** workflow (`deploy.yml`) lets an operator pick either environment (the input is checked **before** the tag ref, so a dispatch from a `v*` tag selecting "staging" still deploys staging) — the manual dispatch button no longer lives on `backend-deploy.yml` or `ingest-deploy.yml` directly; both are reusable `workflow_call` workflows that `deploy.yml` invokes with the resolved `environment`, running `apps/ingest` first and then the backend.

### What a backend deploy does

`deploy.yml` resolves the environment (`main` push → `staging`, `v*` tag → `production`, else the `workflow_dispatch` input) and, once `apps/ingest` has deployed successfully, calls `backend-deploy.yml` (single "Deploy & verify" job, `environment:` = the resolved env) as a reusable `workflow_call` workflow:

1. **Resolve environment** — surface the `environment` input the `deploy.yml` orchestrator resolved and passed in.
2. **Resolve targets** — read env-scoped `vars.BACKEND_URL` + `vars.COOLIFY_BACKEND_UUID`.
3. **Stamp version** — `scripts/ci/resolve-app-version.sh` → upsert `TARMOTO_APP_VERSION` + `TARMOTO_SENTRY_RELEASE` into the Coolify app env (`PATCH /api/v1/applications/<uuid>/envs/bulk`).
4. **Trigger deploy** — authenticated `GET /api/v1/deploy?uuid=<uuid>`; capture the deployment id.
5. **Wait** — poll `/api/v1/deployments/applications/<uuid>` for that deployment id until `finished` (do **not** trust `/healthz` alone — the old container serves 200 during the rolling update).
6. **Healthcheck + smoke** — `/api/v1/healthz` then `scripts/smoke/smoke.sh`.
7. **On failure** — surface **manual** rollback instructions (Coolify v4 has no rollback API; there is no automated rollback).

### Releasing to production

1. Verify `main` is healthy on staging — the Backend Deploy run for the head of `main` should be green and `api-staging.tarmoto.app/api/v1/healthz` should return 200.
2. Cut a tag from `main`:
   ```bash
   git fetch origin
   git tag -a v0.X.Y origin/main -m "Release v0.X.Y"
   git push origin v0.X.Y
   ```
3. The tag push runs the `deploy.yml` orchestrator, which resolves `production`, deploys `apps/ingest` first, then — only if ingest succeeds — calls `backend-deploy.yml` for `production`: stamps the version → triggers the Coolify deploy API → tracks the deployment to `finished` → healthcheck against `api.tarmoto.app` → `scripts/smoke/smoke.sh`.
4. The same `v*` tag fans out to every surface: `companion-deploy.yml` and `marketing-deploy.yml` resolve the `production` target on `v*`, and `mobile-release.yml` builds + submits the app to TestFlight / Play Internal (deriving the version from the tag). One tag ships ingest, backend, companion, marketing, and mobile at the same commit. Accepted tradeoff: a `v*` tag rebuilds mobile too — for a server-only hotfix, use `workflow_dispatch` on the **`Deploy`** workflow (which redeploys only `apps/ingest` + backend, not mobile/companion/marketing) instead of cutting a tag.

### Verifying the staging/production split

Both apps have Auto Deploy OFF, so the split is enforced by the trigger ref + env-scoped GitHub config. After any PaaS upgrade, app re-creation, or restore from backup:

1. Push a no-op commit to a feature branch, merge to `main`, watch GitHub Actions:
   - **Backend Deploy** fires; the "Resolve environment" step outputs `name=staging`.
   - "Resolve env-specific deploy targets" resolves the **staging** `BACKEND_URL` / `COOLIFY_BACKEND_UUID`.
   - The Coolify deployment targets the **staging** app UUID; healthcheck/smoke hit `api-staging.tarmoto.app`.
2. Production's deploy history shows **no** new deploy from this `main` push.
3. Tag the same commit, push the tag, confirm production deploys and the smoke runs against `api.tarmoto.app`.

If a `main` push ever deploys production, check that Coolify Auto Deploy is still OFF on the production app (`Application → Advanced Settings → Deployment → Auto Deploy`) — CI must be the only trigger.

### Rollback (production)

CI does **not** roll back automatically (Coolify v4 exposes no rollback API); on failure it prints the recent deployments and these manual steps:

1. Coolify UI → Production application → **Deployments**.
2. Find the last known-good deployment (one before the bad one).
3. Click **Redeploy** on that row.
4. Watch the deploy logs until traffic switches; verify `api.tarmoto.app/api/v1/healthz` returns 200.
5. Run `scripts/smoke/smoke.sh https://api.tarmoto.app` locally as a final check.

### Required GitHub Secrets / Variables

Per `.github/workflows/backend-deploy.yml`:

**Repo-level secret:**

- `COOLIFY_API_TOKEN` — authenticates the deploy trigger, version-env stamping, and deploy-status polling (issued from the Coolify dashboard).

**Repo-level variable:**

- `COOLIFY_API_BASE_URL` — base URL of the Coolify API (no trailing slash).

**Per-environment variables (`staging` / `production` GitHub Environments):**

- `BACKEND_URL` — the environment's backend origin (`https://api-staging.tarmoto.app` / `https://api.tarmoto.app`).
- `COOLIFY_BACKEND_UUID` — the backend app's Coolify UUID for that environment.

### Deploying `apps/ingest` (POI ingestion service)

`apps/ingest` (`@tarmoto/ingest-service`) is a separate NestJS deployable — the always-on POI-import BullMQ worker + weekly/monthly extract-refresh target + the **sole owner of the POI-database migrations** (`migrationsRun: true`). See "Schema ownership" under POI database topology below for the resulting deploy-order constraint. It deploys through the **same** authenticated Coolify API mechanism as the backend (Auto Deploy OFF, CI-triggered), with its own per-environment `INGEST_URL` / `COOLIFY_INGEST_UUID` GitHub variables mirroring `BACKEND_URL` / `COOLIFY_BACKEND_UUID`.

**Deploying `apps/ingest`.** `apps/ingest` has its own `ingest-deploy.yml`, mirroring `backend-deploy.yml` exactly: both are reusable `workflow_call` workflows invoked by the `deploy.yml` orchestrator, which resolves staging vs production (push `main` → staging, tag `v*` → production, or the `workflow_dispatch` choice) and always deploys `apps/ingest` before the backend — same Coolify API mechanism, same version-stamping step (`TARMOTO_APP_VERSION` + `TARMOTO_SENTRY_RELEASE` only — `TARMOTO_DEPLOY_ENV` is a static per-environment Coolify var, not stamped), and the same manual-rollback-instructions-on-failure step. Two deltas: the post-deploy check hits `/healthz` (not `/api/v1/healthz`), and there is no smoke-test step — no ingest-specific smoke script exists yet. Provisioned (2026-07-17): the Coolify `apps/ingest` application exists for staging + production and the `INGEST_URL` / `COOLIFY_INGEST_UUID` GitHub Environment variables are set for both — **staging is live**; production deploys on the next `v*` tag (or a manual `workflow_dispatch` on the **Deploy** workflow). The workflow still fails fast on its guards if a value is ever missing. `ingest-ci.yml` continues to build/lint/test it on every push.

**Deploy order is load-bearing** — and now enforced by the `deploy.yml` orchestrator, which deploys `apps/ingest` **first** (it applies any pending POI-database migrations on boot) and only runs the backend job on ingest success — **then** the slimmed backend. The backend's `'poi'` connection runs `migrationsRun: false` (a tolerant reader of a schema that may already be ahead of what it shipped with): deploying the backend before `apps/ingest` never fails its boot, but it won't see new POI columns/tables until `apps/ingest` has actually migrated them.

**Internal API + admin-page dependency (Phase 3 cutover).** `apps/ingest` now also serves a token-guarded `/internal/poi/*` API (`GET regions`, `GET runs`, `POST import`, `GET import-status`) that the backend's admin POI management page (`/admin/poi/*`) proxies to for coverage, run history, and the manual trigger — the backend dropped its own `poi.import` queue entirely. `storeExtract` (the extract-upload path) also calls `GET import-status` before accepting a replacement extract, to confirm no import for the same `(source, code)` is currently running (#1011 review). This makes the ingest-first deploy order above doubly load-bearing: it was already required for the POI-database migrations, and now the admin page — **uploads included** — also depends on `apps/ingest` being up and reachable. Required config: `TARMOTO_INTERNAL_API_TOKEN` — the same secret — on **both** `apps/ingest` and the backend (the backend already sets this for the admin-Worker→backend edge; the identical value doubles as the credential the backend sends onward as `x-internal-token`), and `TARMOTO_INGEST_INTERNAL_URL` on the backend (`apps/ingest`'s internal, non-internet-facing address) — **required for extract uploads as well as trigger/coverage/runs**, not only the latter. **Degradation if either is unset or `apps/ingest` is unreachable:** the admin page's trigger/coverage/run-history calls fail with `503` (or `401` if both are configured but the `TARMOTO_INTERNAL_API_TOKEN` values don't match between the backend and `apps/ingest`); **extract uploads also fail closed with `503`**, because `apps/ingest` runs its always-on worker and weekly/monthly refresh **independently** of whether the backend can reach it — an unset or unreachable URL never proves no import is running, so the backend refuses to replace the extract rather than risk a worker still reading the old file. POI store reads (`PoiService` / `PoiStoreService`) and the weekly scheduled import inside `apps/ingest` itself remain unaffected, since neither depends on this API — that same independence is exactly why the backend cannot treat "unreachable" as "nothing is importing." `apps/ingest` is now deployed via `deploy.yml` (staging live); the remaining backend-side requirement for the admin page — **uploads included** — is `TARMOTO_INGEST_INTERNAL_URL` (+ a matching `TARMOTO_INTERNAL_API_TOKEN`) on the backend: **extract uploads through the admin page 503 until those are set on the backend.**

**A stale pre-cutover job is harmless.** The `poi.import` queue now lives wholly inside `apps/ingest` (same Redis, same queue name) — a job enqueued by an old, pre-cutover backend before this deploy is simply picked up by `apps/ingest`'s worker like any other. If the `(source, code)` it names is no longer enabled/configured under the Phase 3 enablement view, the worker's existing graceful-skip guard (`PoiImportProcessor.recordUnconfiguredRegionSkip`) records a `skipped` run instead of failing — no manual cleanup needed.

## Databases & Migrations

### POI database topology

The POI (point-of-interest) database is a **separate PostgreSQL + PostGIS instance** (see [ADR 0007](../decisions/0007-separate-poi-database.md)). It isolates the high-write POI data path from the core backend database, reducing contention and operational risk.

**Local development:**

```bash
pnpm db:up                  # Starts both tarmoto (5433) and tarmoto-poi-db (5434) Compose services
pnpm db:migrate:poi         # Runs POI database migrations
```

`db:migrate:poi` builds `@tarmoto/poi-db` and `@tarmoto/ingest-service`, then runs the POI migrations through `@tarmoto/ingest-service`'s CLI DataSource — the backend no longer runs POI migrations itself (see "Schema ownership" below).

**Production:**

Provision a dedicated Coolify Postgres instance (separate from the core backend database). Set the following on **both** the backend Coolify application (POI reader + admin front-door) **and** the `apps/ingest` Coolify application (POI writer + migrator):

- `TARMOTO_POI_DATABASE_HOST`
- `TARMOTO_POI_DATABASE_PORT`
- `TARMOTO_POI_DATABASE_NAME`
- `TARMOTO_POI_DATABASE_USER`
- `TARMOTO_POI_DATABASE_PASSWORD`

**PostGIS must be available in the POI database.** The POI migration lineage runs `CREATE EXTENSION IF NOT EXISTS postgis` before creating spatial columns, so `TARMOTO_POI_DATABASE_USER` needs privileges to create extensions — otherwise a superuser must install PostGIS in the POI database once, up front, before `pnpm db:migrate:poi`. (Locally the `postgis/postgis` image does this automatically, which is why dev never hits it.)

**Schema ownership.** `apps/ingest` is the sole migrator (`migrationsRun: true`, applied on boot) — it owns the POI-DB migration lineage (`@tarmoto/poi-db`). The backend's `'poi'` connection runs `migrationsRun: false`: it only ever reads — the Phase 3 cutover dropped the backend's `poi.import` queue registration entirely — and tolerates a schema that's already ahead of what it shipped with. **Deploy order at cutover:** `apps/ingest` first (applies pending POI migrations), then the slimmed backend — see "Deploying `apps/ingest`" above.

### POI database resilience

The backend **tolerates the POI database being unavailable**. When the POI DB is down:

- POI store reads return `503 Service Unavailable`.
- `GET /poi/health` reports `{ poiDb: 'down' }` (while the rest of the app status remains healthy).
- The rest of the backend stays operational; trips, users, and ride data are unaffected.

This design allows POI data maintenance (migrations, backups, maintenance windows) without blocking core app traffic.

### Populating the POI store

The POI store starts empty; store read endpoints return an empty result (not an error) for regions that have not been imported yet. The store is filled from **per-country Geofabrik `.osm` extracts** (produced with `osmium tags-filter` — see [Producing per-country POI extracts](#producing-per-country-poi-extracts)), **not** a live Overpass bbox: bulk extracts scale to the full 17-country coverage list without hitting the Overpass public-API limits. Overpass stays the live read-path fallback (`poi.service`, backend), never the bulk importer. **The extract + import + migration write path lives entirely in `apps/ingest`** (`@tarmoto/ingest-service`) — the backend is a POI reader plus a thin admin front-door that proxies coverage/runs/trigger calls to `apps/ingest`'s internal API and still receives extract uploads onto the shared volume. Two ways to fill the store:

- **On demand:** `pnpm poi:import` builds and runs `@tarmoto/ingest-service`'s CLI (`apps/ingest/dist/scripts/import-pois.js`), importing once over the configured regions (`TARMOTO_OSM_POI_IMPORT_REGIONS`, default all 17) from the extracts in `TARMOTO_OSM_POI_IMPORT_DIR`. It writes to the POI database and bypasses the `TARMOTO_OSM_POI_IMPORT_ENABLED` gate, so a one-off run doesn't need the flag flipped.
- **Recurring (production):** the weekly BullMQ import cron (scheduler + processor, `poi.import` queue, Sunday 03:00 UTC) runs in **`apps/ingest`'s own always-on worker** — a separate deployable from the backend, not a worker-mode instance of it. The weekly dispatch fans out over **every enabled source** (#869): it enqueues one staggered per-region job for each source whose `TARMOTO_<SOURCE>_POI_IMPORT_ENABLED` is set, so OSM and FSQ refresh from the same weekly tick. Set `TARMOTO_OSM_POI_IMPORT_ENABLED=true`, `TARMOTO_OSM_POI_IMPORT_DIR`, and (optionally) `TARMOTO_OSM_POI_IMPORT_REGIONS` **on `apps/ingest`** for OSM (and the `TARMOTO_FSQ_POI_IMPORT_*` trio for FSQ); setting them only on the backend has no effect. `apps/ingest` also needs `TARMOTO_POI_DATABASE_*` (it writes to the POI DB and owns its migrations). Leave every `*_IMPORT_ENABLED` unset/`false` in dev and CI so they don't run a continent-scale import.
- **Admin UI (#847):** operators can upload an extract + trigger a per-region import from the admin app (`/admin/poi`) instead of placing files + running the CLI. The backend proxies this trigger to `apps/ingest`'s token-guarded internal API (`POST /internal/poi/import`, `x-internal-token` vs `TARMOTO_INTERNAL_API_TOKEN`) instead of enqueueing it directly — the Phase 3 cutover dropped the backend's own `poi.import` queue entirely. `apps/ingest` validates the `(source, code)` pair (**400s** a disabled/unconfigured one — the enablement view, data-sources-and-storage.md §8.3) and enqueues onto its own `poi.import` queue; **its worker is what actually runs the import.** **Critical for this split:** the upload writes the extract to `TARMOTO_*_POI_IMPORT_DIR` on the **backend**, but the import job runs in **`apps/ingest`** — so that directory MUST be **shared storage mounted in both the backend and `apps/ingest` containers** (a shared volume). Without it the admin page shows the extract "present" (read from the backend's filesystem) while `apps/ingest`'s import can't see the file and records a **skipped** run. That skip is visible in the admin run history (so it isn't silent), but a shared mount is required for the admin upload→import flow to work at all. If the extract dir isn't configured on the backend, the upload returns a clear 503. **Volume ownership:** both the backend's and `apps/ingest`'s images create each configured `TARMOTO_*_POI_IMPORT_DIR` (OSM **and** FSQ — independent paths) owned by the same non-root `tarmoto` user (uid 100 in both images), so a **fresh** named volume mounted there comes up writable regardless of which container mounts it first. A volume that already exists **root-owned** (provisioned before this) must be `chown tarmoto:tarmoto`'d once (or recreated), or uploads fail with `EACCES`; if OSM and FSQ use **separate** volumes, each needs it. _(Follow-up: move extracts to `apps/ingest`-visible object storage to drop the shared-mount requirement.)_

Both paths read the per-region `.osm` files an operator prepares out-of-band; produce them first.

A **second bulk source**, Foursquare OS Places (#869, `source='fsq'`), imports the same way from per-region `.fsq.jsonl` extracts — see [Producing per-country POI extracts (Foursquare OS Places)](#producing-per-country-poi-extracts-foursquare-os-places). It has its own env vars (`TARMOTO_FSQ_POI_IMPORT_ENABLED/DIR/REGIONS`) and CLI (`pnpm fsq:import`), coexists with OSM in `pois` via the `(source, external_id)` key, and is now included in the weekly cron (above) when `TARMOTO_FSQ_POI_IMPORT_ENABLED=true`. Cross-source de-dup has landed (#932), so an imported FSQ row no longer double-pins an OSM venue. **Still not prod-safe:** store reads filter by `kind`, not `source`, so an imported FSQ row is served immediately, and Apache-2.0 requires visible Foursquare attribution — which isn't wired into the companion yet. Until attribution lands, only import FSQ on dev/staging.

### Region-coverage boundaries (#944)

Store reads are **coverage-aware**: `PoiService.readStoreFirst` treats an empty
store result as authoritative (skips the Overpass fallback) only when the request
falls inside an **imported region's boundary polygon**, and merges Overpass at the
import frontier otherwise. That decision (`PoiStoreService.isRequestCovered`) runs
`ST_Covers(region_polygon, request)` against the `poi_import_regions` table, gated
on `imported_at IS NOT NULL`.

- **One-time (and whenever the asset changes):** `pnpm poi:load-boundaries` — now
  building and running via **`apps/ingest`** (`@tarmoto/ingest-service`'s
  `apps/ingest/dist/scripts/load-region-boundaries.js`) — loads the 17 country
  boundary polygons (Natural Earth 1:50m, committed at
  `apps/ingest/src/assets/import-region-boundaries.geojson`) into
  `poi_import_regions`. Run it **after** `pnpm db:migrate:poi`; it needs
  `TARMOTO_POI_DATABASE_*` where you run it. Idempotent (`ON CONFLICT (code)`),
  and it never resets `imported_at`.
- **`imported_at` is stamped by the OSM import:** a region counts as covered only
  once `pnpm poi:import` (OSM) has successfully imported it — the importer stamps
  `poi_import_regions.imported_at` for that region (FSQ imports do **not** stamp,
  since the fallback this gates is OSM-backed). So the deploy/refresh order is
  `db:migrate:poi` → `poi:load-boundaries` (once) → `poi:import` — all three now
  build and run through `@tarmoto/ingest-service` in `apps/ingest`. **Ordering
  footgun unchanged:** the coverage stamp is an existing-row-only `UPDATE`, so
  boundaries loaded after the first import silently never take effect for
  already-imported regions — load them first.
- **Until boundaries are loaded, coverage is inert** — `isRequestCovered` returns
  false for every request, so reads simply fall back to Overpass (safe, but the
  import's Overpass-suppression never kicks in). Load them as part of provisioning.
- **Halo regression is a manual pre-release gate:** `apps/backend/test/poi-coverage.e2e-spec.ts`
  proves a point in a neighbouring country (inside the imported country's bounding
  box but outside its polygon) reads as **not** covered. It needs real PostGIS and,
  like the other backend `*.e2e-spec.ts`, does **not** run in CI — run it locally
  (`pnpm --filter @tarmoto/backend exec jest --config ./test/jest-e2e.json test/poi-coverage.e2e-spec.ts`)
  against a migrated + boundary-loaded POI DB before a coverage-affecting release.

### Producing per-country POI extracts

The bulk POI import reads one `.osm` XML file per active region from `TARMOTO_OSM_POI_IMPORT_DIR`, named `<code>.osm` (lower-case ISO 3166-1 alpha-2, e.g. `cz.osm`). An operator prepares each file once per refresh from the country's Geofabrik download, mirroring the roads OSM importer's prep (`../../apps/backend/src/modules/roads/osm-import/README.md`). The importer reads `.osm` XML, not `.osm.pbf` directly — the maintained JS PBF parsers are stale; osmium decodes PBF far better.

Per country:

1. **Download** the Geofabrik per-country `<country>-latest.osm.pbf`.
2. **`osmium tags-filter`** down to the §7 POI tag set (fuel, food incl. `fast_food`, accommodation, viewpoints, rest areas, ice cream) — a small fraction of the country file.
3. **`osmium extract -b`** to the region's **authoritative bbox** from `DEFAULT_REGIONS` (`../../packages/ingest/src/poi/regions.ts`), writing `.osm` XML.
4. **Place** the result in `TARMOTO_OSM_POI_IMPORT_DIR` as `<code>.osm`.

The clip bbox MUST equal the region's `DEFAULT_REGIONS` bbox, because that same bbox bounds **stale-by-absence tombstoning**: a re-import soft-deactivates (`deactivated_at`, an UPDATE never a DELETE) rows _inside_ the region bbox that are absent from the new extract (closed venues), and never touches rows outside it. An extract clipped to less than its region bbox would wrongly tombstone the in-bbox rows it failed to cover. `osmium extract -b` keeps every complete object crossing the box (it doesn't cut geometries); the importer constrains generated rows to the same bbox, so edge overhang reconciles only where it belongs — the extract just has to COVER the region. (Coordinate order: `osmium extract -b` takes `minLng,minLat,maxLng,maxLat`, the reverse of Overpass's `south,west,north,east`.)

**Worked example — Czech Republic (`CZ`, the launch region):**

```bash
# 1. Geofabrik per-country extract
curl -L -o cz-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf

# 2. Filter to the §7 POI tag set (nodes, ways + relations — hotels,
#    campsites, rest areas are often mapped as areas, not just points)
osmium tags-filter cz-latest.osm.pbf \
  nwr/amenity=fuel,restaurant,cafe,fast_food,ice_cream \
  nwr/tourism=hotel,guest_house,motel,hostel,chalet,apartment,camp_site,viewpoint \
  nwr/highway=rest_area,services \
  nwr/shop=ice_cream \
  -o cz-poi.osm.pbf

# 3. Clip to CZ's authoritative bbox from DEFAULT_REGIONS
#    (minLng,minLat,maxLng,maxLat = 12.09,48.55,18.86,51.06) and write .osm XML
osmium extract -b 12.09,48.55,18.86,51.06 cz-poi.osm.pbf \
  -o "$TARMOTO_OSM_POI_IMPORT_DIR/cz.osm"
```

Repeat per country in the active set, each clipped to its own `DEFAULT_REGIONS` bbox. Then enable the import on **`apps/ingest`**: `TARMOTO_OSM_POI_IMPORT_ENABLED=true`, point `TARMOTO_OSM_POI_IMPORT_DIR` at the folder of `.osm` files, and narrow coverage with `TARMOTO_OSM_POI_IMPORT_REGIONS` (e.g. `CZ,SK,AT`); unset imports all 17.

**Validate volume + runtime before enabling all regions in production (#850 acceptance criterion).** Region-wide the filtered set is low millions of rows; `pois` is GiST-indexed on `geom` and GIN-indexed on `tags` (plus the `(source, external_id)` unique and `(address_country, kind)` browse index), so store reads stay bounded — but the import's fetch/upsert cost and the worker's memory/runtime scale with coverage. Bring regions online **incrementally**: validate per-country row counts and a full-run wall-clock on staging before flipping all 17 on in production at once.

#### Automating the OSM refresh (scheduled container, #976)

The manual steps above (download → `tags-filter` → clip → place) can run
automatically so the weekly import mirrors **current** data instead of
re-importing a static file. **`apps/ingest`** — the same always-on service that
runs the `poi.import` BullMQ worker/scheduler and owns the POI-DB migrations —
also carries the `osmium`/`duckdb` tooling for this. Its `pnpm poi:refresh` →
`apps/ingest/dist/scripts/refresh-poi-extracts.js` runs exactly that per-country
pipeline for every configured region, writing each `<code>.osm` **atomically**
to `TARMOTO_OSM_POI_IMPORT_DIR`. (The standalone `apps/backend/Dockerfile.poi-refresh`
one-shot container this used to run in is **retired** — its osmium/duckdb role
folded into `apps/ingest`'s image.)

`apps/ingest` is kept **separate** from the backend image on purpose — osmium
and multi-GB PBF handling don't belong in the app runtime — and its build
pulls in `packages/ingest`, so the clip bbox comes straight from
`DEFAULT_REGIONS` and can't drift. Region set + target dir are the **same** env
as the importer (`TARMOTO_OSM_POI_IMPORT_REGIONS` / `TARMOTO_OSM_POI_IMPORT_DIR`); the
Geofabrik country slugs live in `packages/ingest/src/poi/refresh-config.ts` (a spec asserts every region has one).

Operate the refresh as a **scheduled task** (Coolify scheduled task / cron),
timed to finish comfortably **before** the Sunday 03:00 UTC import tick (e.g.
Saturday):

- `TARMOTO_OSM_POI_REFRESH_ENABLED=true` — off by default; the script no-ops
  otherwise.
- Mount the **same shared extract volume** at `TARMOTO_OSM_POI_IMPORT_DIR` that the
  backend (admin uploads) and `apps/ingest` (the importer) read. One
  `apps/ingest` deployment can feed **both staging and prod** from a single
  shared volume — the `<code>.osm` files are environment-agnostic (filtered
  OSM), so producing them once avoids duplicating the (multi-GB) set per
  environment. Every party that touches the volume — `apps/ingest`, the staging
  backend, the prod backend — runs as **uid 100** (both images pin it to the
  same volume owner), so writes here are readable by, and replaceable by, all
  of them. (A corollary of one shared volume: an admin upload on one
  environment lands the same file every environment then imports — intended
  here, but worth knowing.)
- (optional) `TARMOTO_OSM_POI_IMPORT_REGIONS` to refresh a subset.
- Ephemeral disk for the largest single country PBF (~4 GB for DE) plus its
  filtered copy — regions run sequentially and clean up between, so peak disk is
  one country, not all 17.
- **Deploy model (Coolify / PaaS):** `apps/ingest` is deployed as a normal
  **always-on** application — the `poi.import` worker + weekly scheduler run
  continuously and it serves `/healthz` — **not** an idling placeholder. Add a
  **Scheduled Task** that `docker exec`s
  `node apps/ingest/dist/scripts/refresh-poi-extracts.js` into the
  already-running container on the cron. Because the container is never
  one-shot, there's no restart-loop risk from the refresh script exiting — it's
  a one-off exec against a long-lived process, not the container's own
  entrypoint.
- **Memory / swap:** osmium building a country-sized index spikes RAM (~1–2 GB
  for a country PBF). On a small or shared host ensure real headroom — and
  **swap** especially: a **no-swap host OOM-kills osmium** the instant it tips
  over (surfaces as `killed by SIGKILL`). A few GB of swap is the cheap fix.

Behaviour:

- **Atomic + keep-last-good:** each extract is built at a sibling `.part` file
  and only renamed onto `<code>.osm` after every step succeeds. A failed
  download/filter/clip leaves the previous good extract untouched (never a
  truncated file) and the run continues to the next region.
- **Observable:** the refresh script exits **non-zero** if any region failed
  (so the scheduler can alert on the `docker exec`'s exit code), and logs every
  region's outcome. The next import simply re-imports whatever landed — a
  region whose refresh failed re-imports its prior extract.

The manual pipeline above stays the fallback (one-off refresh, a region with no
Geofabrik slug, or before the scheduled task is provisioned). The **FSQ**
source is automated the same way — a `duckdb` pull in the **same** `apps/ingest`
container, on its own monthly schedule (see
[Automating the FSQ refresh](#automating-the-fsq-refresh-scheduled-container-976)).

**Manual uploads vs. the refresh — who owns which region.** The scheduled
container is the **authoritative** source for the extracts of the regions it
refreshes (`TARMOTO_OSM_POI_IMPORT_REGIONS`). Do **not** hand-upload those regions
via the admin UI: the next refresh re-overwrites the file, so a manual override
won't survive the following run (the atomic rename means it's never _corrupt_,
just replaced). Reserve the admin upload for regions the container does **not**
refresh, or for one-off / pre-provisioning loads. And because the extract volume
is shared, any write — a refresh **or** an admin upload — lands the same file
that **every** environment's import then reads, so treat a manual upload as a
cross-env action. (This operational contract is why the refresh doesn't take the
admin upload lock: it owns its regions and the atomic rename rules out a torn
file — see #986 for the analysis and the heavier per-region-lock option, which
was deferred as disproportionate.)

### Producing per-country POI extracts (Foursquare OS Places)

The FSQ bulk import (#869) reads one **newline-delimited JSON** file per active region from `TARMOTO_FSQ_POI_IMPORT_DIR`, named `<code>.fsq.jsonl` (lower-case ISO code, e.g. `cz.fsq.jsonl`). It's a second `source` (`'fsq'`) stored alongside OSM in `pois`; it uses [FSQ OS Places](https://docs.foursquare.com/data-products/docs/access-fsq-os-places) — the free, Apache-2.0, monthly-refreshed open dataset — **not** the Places API (the API's ToS forbids bulk-storing its data; OS Places is built for it).

OS Places is delivered through the **Foursquare Places Portal** as a token-gated **Iceberg catalog** (the legacy public S3 Parquet bucket is deprecated). We keep the query + filter **offline** (like the osmium step above), so the backend only ever streams a small per-region extract and no FSQ credential reaches production. An operator runs a DuckDB recipe once per refresh:

Per region:

1. **Get a token.** Create a free [FSQ Places Portal](https://places.foursquare.com/) account and generate an access token — it's **short-lived (~1 month)**, so regenerate each refresh (which lines up with the dataset's monthly cadence).
2. **Connect DuckDB to the Iceberg catalog** with the connection snippet the Portal generates for your token (it attaches the catalog exposing the `places` table; needs DuckDB's `iceberg` extension). Those details are token/catalog-specific — copy them from the Portal, don't hardcode them here.
3. **Filter** to the region's **ISO-2 country** + its `DEFAULT_REGIONS` bbox + `date_closed IS NULL` + a coarse category prefilter, joining the FSQ category arrays to comma strings, and write NDJSON. The country predicate is essential — `places` is a global table, so bbox alone pulls in cross-border neighbours (the importer would then mis-own them). The backend classifier (`fsq-poi-categories.ts`) does the precise category → `kind` mapping, so the SQL category prefilter only needs to be a loose superset.
4. **Place** the result in `TARMOTO_FSQ_POI_IMPORT_DIR` as `<code>.fsq.jsonl`.

**Worked example — Czech Republic (`CZ`)** — once the Portal's connect snippet (step 2) has attached the catalog, the filter/export is:

```sql
-- After the Portal's DuckDB connect snippet attaches the `places` catalog:
--   INSTALL httpfs; LOAD httpfs;
--   CREATE SECRET iceberg_secret (TYPE ICEBERG, TOKEN '<YOUR_TOKEN>');
--   ATTACH 'places' AS places (TYPE iceberg, SECRET iceberg_secret,
--     ENDPOINT 'https://catalog.h3-hub.foursquare.com/iceberg');
-- The OS Places table is then places.datasets.places_os.
COPY (
  SELECT
    fsq_place_id, name, latitude, longitude,
    array_to_string(fsq_category_ids, ',')    AS category_ids,
    array_to_string(fsq_category_labels, ',') AS category_labels,
    tel, website, address, locality, postcode, country
  FROM places.datasets.places_os
  WHERE date_closed IS NULL
    -- `places` is GLOBAL (unlike a per-country Geofabrik file), and the CZ bbox
    -- overlaps DE/PL/SK/AT at the borders. Scope by country too, or neighbours'
    -- POIs get imported and stamped import_region='CZ' — wrong owner + tombstone
    -- scope. Use each region's ISO-2 code (the same as its DEFAULT_REGIONS code).
    AND country = 'CZ'
    -- CZ bbox from DEFAULT_REGIONS (minLng,minLat,maxLng,maxLat = 12.09,48.55,18.86,51.06);
    -- also the importer's tombstone bound, so keep it aligned.
    AND longitude BETWEEN 12.09 AND 18.86
    AND latitude  BETWEEN 48.55 AND 51.06
    -- Coarse category prefilter. It MUST stay a SUPERSET of the labels in
    -- fsq-poi-categories.ts — loose is fine (the backend classifier drops false
    -- positives), but a MISS drops rows the importer would keep and can later
    -- tombstone them as absent. Mirror this when the classifier gains a label.
    AND len(list_filter(fsq_category_labels, x -> regexp_matches(lower(x),
        'restaurant|caf|coffee|tea room|tea house|food|ice cream|gas|petrol|fuel|charging|lookout|viewpoint|overlook|rest area|hotel|motel|hostel|inn|guest|b&b|breakfast|apartment|camp|rv park|caravan|resort|cottage|chalet|cabin|vacation|holiday|rental'))) > 0
) TO '<TARMOTO_FSQ_POI_IMPORT_DIR>/cz.fsq.jsonl' (FORMAT json);
```

Then import with the **manual CLI** — `pnpm fsq:import` (builds and runs via `@tarmoto/ingest-service`; all configured regions from `TARMOTO_FSQ_POI_IMPORT_DIR`, narrowed by `TARMOTO_FSQ_POI_IMPORT_REGIONS`, default all 17) or `node apps/ingest/dist/scripts/import-pois.js fsq CZ` (one region). It bypasses the enabled gate like `poi:import`, and needs `TARMOTO_POI_DATABASE_*` where you run it. FSQ's extract dir + region list are independent of OSM's.

**Weekly FSQ cron.** The weekly BullMQ dispatch (§ above) now fans out over every enabled source, so setting `TARMOTO_FSQ_POI_IMPORT_ENABLED=true` (plus `TARMOTO_FSQ_POI_IMPORT_DIR`) on **`apps/ingest`** refreshes FSQ from the same Sunday tick as OSM — each source gated independently by its own `*_IMPORT_ENABLED`. The manual `fsq:import` CLI stays available for one-off runs.

#### Automating the FSQ refresh (scheduled container, #976)

The manual DuckDB recipe above runs automatically too — in the **same**
**`apps/ingest`** container as the OSM refresh (it carries both `osmium`
and a pinned `duckdb`). `pnpm fsq:refresh` → `apps/ingest/dist/scripts/refresh-fsq-extracts.js`
runs the exact query above for every configured region and writes each
`<code>.fsq.jsonl` **atomically** to `TARMOTO_FSQ_POI_IMPORT_DIR`. The field list,
category prefilter, country + bbox scoping, and the catalog/table are baked into
`packages/ingest/src/poi/refresh-config.ts` (`buildFsqExtractSql`), so the automated extract matches
both what the importer parses and what the manual recipe produces.

Operate it as a **monthly** scheduled task — OS Places refreshes monthly and the
token expires ~monthly — independent of the weekly OSM one:

- `TARMOTO_FSQ_POI_REFRESH_ENABLED=true` — off by default (a no-op otherwise).
- `TARMOTO_FSQ_POI_TOKEN` — a Places Portal access token. **This is the one
  irreducible manual step:** it's short-lived (~monthly), so an operator rotates
  it each refresh. It lives **only in the refresh step** (inside `apps/ingest`,
  fed to DuckDB on **stdin** — never a CLI arg / process-list entry) and never
  reaches the app runtime otherwise — neither the backend nor `apps/ingest`'s
  own import worker ever see the token; both only ever read the credential-free
  `.fsq.jsonl` files. That keeps the manual recipe's "no FSQ credential in the
  app runtime" boundary intact under automation.
- `TARMOTO_FSQ_POI_IMPORT_DIR` — the shared extract volume the importer reads
  (independent of the OSM dir); `TARMOTO_FSQ_POI_IMPORT_REGIONS` (optional) to narrow
  the set. Same **uid 100** ownership rule as OSM (see above).
- **Deploy model** is identical to OSM: `apps/ingest` is always-on, not idling;
  add a second **Scheduled Task** that `docker exec`s
  `node apps/ingest/dist/scripts/refresh-fsq-extracts.js` into the running
  container on the monthly cron.
- **Extensions + memory:** DuckDB `INSTALL`/`LOAD`s `httpfs` + `iceberg` at
  runtime (cached under the container user's `$HOME/.duckdb`, which the image
  provisions writable for uid 100), so a run needs network to DuckDB's extension
  repo as well as to the FSQ catalog. The scan is bounded by `SET memory_limit`
  and spills to a temp dir, so a large country doesn't OOM (the osmium lesson).

Behaviour matches OSM: **atomic keep-last-good** (COPY to a `.refresh.part`
sibling, renamed onto `<code>.fsq.jsonl` only on a clean `duckdb` exit — a failed
run keeps the previous extract) and a **non-zero exit** if any region failed, so
the scheduler can alert.

**Prod-safe as of the attribution work (#869).** Both prior gates are met: cross-source OSM↔FSQ dedup landed (#932), and the companion now credits Foursquare **data-driven** — the map info bar (latched on once FSQ POIs appear), the stops-tab legend (a blue Foursquare dot while FSQ stops are present), and each FSQ POI's popover (`© Foursquare`). The Apache-2.0 / NOTICE.txt attribution is preserved below. FSQ stays **disabled by default** (`TARMOTO_FSQ_POI_IMPORT_ENABLED` unset); enable it per environment when its extracts are provisioned.

#### Foursquare OS Places NOTICE

Apache-2.0 requires preserving Foursquare's attribution; because we distribute the Data via our API, the [NOTICE.txt](https://opensource.foursquare.com/places-notice-txt/) content is reproduced here (kept verbatim — update only to note our own modifications):

```
Foursquare OS Places Notice

© 2026 Foursquare Labs, Inc. All rights reserved.

The Foursquare OS Places dataset (the "Data") is licensed under the Apache
License, Version 2.0 (the "License"). You may not use, modify, or distribute the
Data except in compliance with the License.

As set forth more fully in the License, if you use, modify, or distribute the
Data, you must:
– provide recipients with a copy of the License.
– if applicable, include prominent notices to the extent you've changed the Data.
– preserve attribution to Foursquare, including preserving the full content of
  this NOTICE.txt file.

You may obtain a copy of the License at: http://www.apache.org/licenses/LICENSE-2.0.
Unless required by applicable law or agreed to in writing, the Data distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.
```

Tarmoto serves the Data unmodified aside from filtering to our coverage regions + POI categories and mapping FSQ categories to our store `kind` vocabulary.

### Road-quality extract refresh (Sub-project B)

The weekly OSM **road** import (`road.import`, in the **backend**, Sunday
01:00 UTC — see [Scheduled jobs](../reference/architecture.md#scheduled-jobs))
reads a grid of per-**tile** `.osm` XML files per active region from
`TARMOTO_OSM_ROAD_IMPORT_DIR`, named `<code>-r<row>c<col>-s<span>.osm`
(lower-case ISO 3166-1 alpha-2 + 0-based row/col + the tile span with `.`
replaced by `_`, e.g. `cz-r0c1-s2_5.osm`) — the `-s<span>` suffix is a
grid-identity discriminator (`roadTileFileName`): it encodes
`TARMOTO_OSM_ROAD_TILE_SPAN_DEG` so a retuned span can never collide with a
stale-grid file of the same row/col that denotes a DIFFERENT bbox — a
stale-grid file is simply "absent" to the current importer (skipped), never
mis-reconciled — the **folder model**
(Sub-project B) with **sub-region tiling**: each region is subdivided into a
deterministic `<= TARMOTO_OSM_ROAD_TILE_SPAN_DEG`-degree grid (default 2.5°) and
imported tile-by-tile, so peak memory is bounded to one tile regardless of country
size (large countries like DE/IT/PL are safe to enable). The span **MUST match**
on `apps/ingest` (producer) and the backend (importer) — both call
`subdivideRegion` with it to derive the identical grid. The full config and the
`complete_ways` per-tile polygon∩bbox scoping contract are documented in
[`apps/backend/src/modules/roads/osm-import/README.md`](../../apps/backend/src/modules/roads/osm-import/README.md);
this section covers producing (and automating) the extracts themselves, which
mirrors the [OSM POI refresh](#automating-the-osm-refresh-scheduled-container-976)
above with one key difference: **`apps/ingest` only produces the road
extracts — the backend, not `apps/ingest`, is the importer.**

**The road extract dir MUST differ from the POI one**
(`TARMOTO_OSM_ROAD_IMPORT_DIR` ≠ `TARMOTO_OSM_POI_IMPORT_DIR`) — both write
`.osm` files, so sharing a directory would let the two refreshes silently
overwrite each other's extracts.

#### Producing per-region road extracts

Per region, mirroring the POI OSM pipeline but filtered to the
**drivable-highway** tag set (`ROAD_TAGS_FILTER_EXPRESSIONS`,
`packages/ingest/src/roads/road-tags.ts` — the same `DRIVABLE_HIGHWAYS` list
the backend importer gates on) instead of the POI tag set:

1. **Download** the Geofabrik per-country `<country>-latest.osm.pbf`.
2. **`osmium tags-filter`** down to `w/highway=motorway,motorway_link,trunk,…`
   (the drivable classes — footways/cycleways/paths excluded).
3. **`osmium extract -b`** once **per tile** of
   `subdivideRegion(region, TARMOTO_OSM_ROAD_TILE_SPAN_DEG)`, clipped to that
   tile's bbox **padded** by `TILE_EXTRACT_PAD_DEG` (0.05°,
   `packages/ingest/src/roads/road-tiles.ts`) — `complete_ways` only selects a
   way with at least one NODE inside the clip bbox, so the pad keeps a way that
   crosses the tile but whose nearest nodes sit just outside it from being
   silently dropped from this tile's extract; the output filename and reconcile
   scope stay the EXACT (unpadded) tile. Each tile is a cell of the region's
   bbox from `DEFAULT_REGIONS` (`packages/ingest/src/poi/regions.ts` — roads
   reuse the same 17-region list as POI/FSQ). `osmium extract -b` does not
   clip geometries — it keeps every **complete way** that crosses the box
   (`complete_ways`, the default strategy) — so a way straddling two tiles (or
   regions) is written whole into **both** tiles' extracts; the backend importer's
   `filterToRegion` filter scopes the rows it actually reconciles to each tile's
   country-polygon ∩ tile-bbox, so the shared segment upserts idempotently on
   either side. The extract just has to COVER its tile.
4. **Place** the results in `TARMOTO_OSM_ROAD_IMPORT_DIR` as
   `<code>-r<row>c<col>-s<span>.osm` (one file per tile — `roadTileFileName`,
   see above).

**Worked example — Czech Republic (`CZ`):**

```bash
# 1. Same Geofabrik extract the POI/routing infra uses (often already on disk
#    from that refresh)
curl -L -o cz-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf

# 2. Filter to the drivable-highway set (packages/ingest/src/roads/road-tags.ts)
osmium tags-filter cz-latest.osm.pbf \
  w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,service,track \
  -o cz-road.osm.pbf

# 3. Extract to CZ's r0c0 tile bbox — PADDED by TILE_EXTRACT_PAD_DEG (0.05°) on
#    every side, so a way crossing the tile whose nodes sit just outside it is
#    still captured — and write .osm XML. The importer reads per-tile files, so
#    this single-file example is only valid at a tile span >= the region (one
#    r0c0 tile == the region bbox 12.09,48.55,18.86,51.06 — here assuming
#    TARMOTO_OSM_ROAD_TILE_SPAN_DEG=10, hence the `-s10` in the filename below).
#    Real coverage is a grid — the automated refresh below writes every tile,
#    padding included — so prefer it over hand-tiling.
osmium extract -b 12.04,48.50,18.91,51.11 cz-road.osm.pbf \
  -f osm -o "$TARMOTO_OSM_ROAD_IMPORT_DIR/cz-r0c0-s10.osm"
```

Repeat per region in the active set. Then enable the import on the **backend**:
`TARMOTO_OSM_ROAD_IMPORT_ENABLED=true`, point `TARMOTO_OSM_ROAD_IMPORT_DIR` at
the folder of `.osm` files, and narrow coverage with
`TARMOTO_OSM_ROAD_IMPORT_REGIONS` (e.g. `CZ,SK,AT`); unset imports all 17
`DEFAULT_REGIONS`.

**Not yet wired for a live prod region.** Enabling this in production should
wait on **#809** (aggregate-safe road detail / exact clustered-member-set) —
see the module README's "Not yet wired for a live prod region" note.
Dev/staging can enable it freely.

#### Automating the road refresh (scheduled container, Sub-project B)

Like the POI OSM refresh, the manual steps above run automatically from the
**same** always-on `apps/ingest` container (it already carries `osmium` for the
POI refresh — no additional tooling needed). The `apps/ingest` script
`road:refresh` (run from the container as `node
apps/ingest/dist/scripts/refresh-road-extracts.js`, or from the repo root as
`pnpm --filter @tarmoto/ingest-service road:refresh` — it is NOT a root
`package.json` script) runs the drivable-highway
filter once per region then a per-**tile** clip (padded by
`TILE_EXTRACT_PAD_DEG`, see above) for every configured region, writing each
`<code>-r<row>c<col>-s<span>.osm` **atomically** to
`TARMOTO_OSM_ROAD_IMPORT_DIR`.

Region set comes from the **same** `DEFAULT_REGIONS` list as POI (so the clip
bbox can't drift), narrowed by its own `TARMOTO_OSM_ROAD_IMPORT_REGIONS` — an
env independent of the POI one, but conventionally kept in sync since most
deployments want the same coverage for both.

Operate the refresh as a **scheduled task** (Coolify scheduled task / cron),
timed to finish comfortably **before** the Sunday 01:00 UTC `road.import`
tick — note this is **earlier** than the POI import's 03:00 tick, and the road
refresh should be **staggered from the POI OSM refresh** (not run at the same
time — both are osmium/PBF-heavy and would otherwise contend for disk/CPU) —
e.g. Friday, a day before the POI refresh's Saturday:

- `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true` — off by default; the script no-ops
  otherwise.
- Mount a **shared extract volume** at `TARMOTO_OSM_ROAD_IMPORT_DIR` — distinct
  from the POI/FSQ one — that both `apps/ingest` (writer) and the backend
  (reader) mount. Same **uid 100** ownership convention as the POI/FSQ volume
  (see above): one `apps/ingest` deployment can feed staging + prod from a
  single shared volume, same as POI.
- (optional) `TARMOTO_OSM_ROAD_IMPORT_REGIONS` to refresh a subset, and
  `TARMOTO_OSM_ROAD_TILE_SPAN_DEG` to tune the tile span (default 2.5°) — set it
  **identically** on `apps/ingest` and the backend, or the two derive different
  grids and the importer looks for tiles the producer never wrote.
- **Deploy model:** add a second **Scheduled Task** that `docker exec`s
  `node apps/ingest/dist/scripts/refresh-road-extracts.js` into the
  already-running `apps/ingest` container on the cron — the same
  never-one-shot pattern as the POI/FSQ scheduled tasks.
- **Memory / swap:** same osmium RAM spike caveat as the POI refresh (~1–2 GB
  per country PBF); ensure real swap headroom on a small/shared host.

Behaviour matches the POI refresh: **atomic keep-last-good** (`.part` sibling,
renamed onto each `<code>-r<row>c<col>-s<span>.osm` only after that tile's clip succeeds,
so a partially-refreshed region may mix fresh + previous tiles) and a **non-zero
exit** if any region failed, so the scheduler can alert; the next import
simply re-imports whatever landed — a region whose refresh failed re-imports
its prior extracts.

**Enablement order** (ops sequencing — do this in order, not all at once):

1. Set `TARMOTO_OSM_ROAD_IMPORT_DIR` + `TARMOTO_OSM_ROAD_IMPORT_REGIONS` (and, if
   overriding it, `TARMOTO_OSM_ROAD_TILE_SPAN_DEG`) — the **same** values — on
   **both** `apps/ingest` (producer) and the backend (importer). They must agree,
   or the importer reads an empty or wrong folder / a mismatched tile grid.
2. Add the `apps/ingest` scheduled task (`refresh-road-extracts.js`) and set
   `TARMOTO_OSM_ROAD_REFRESH_ENABLED=true` on `apps/ingest`. Let it run at
   least once and confirm `<code>-r<row>c<col>-s<span>.osm` tile files land in
   the shared dir.
3. Only then flip `TARMOTO_OSM_ROAD_IMPORT_ENABLED=true` on the **backend** —
   enabling the importer before the first extracts land just means its first
   weekly tick skips every tile (`no extract at … — skipping`) until the
   refresh has produced them; safe, but pointless to enable early.

On a successful import, the backend automatically chains the road-quality →
GraphHopper conflation (`quality.conflation`, whole-network as of Sub-project
B) — see
[`apps/backend/src/modules/roads/quality-conflation/README.md`](../../apps/backend/src/modules/roads/quality-conflation/README.md).

### Enabling quality-aware routing (GraphHopper + conflation) on staging

Turns the imported `road_segments.quality_score` into **routes that prefer
good-surface roads** (#779, [ADR-0005](../decisions/0005-road-quality-routing-via-smoothness.md)).
The chain: the conflation job injects an OSM `smoothness` tag (derived from our
score) into a whole-network `.osm`, GraphHopper re-imports it, and the
request-time `preferQuality` custom model de-weights the poor tiers. **This is a
routing-infra step, not a flag** — it needs a running GraphHopper. The
road-quality **display** (map + segment cards) already works from `road_segments`
without any of this; conflation only adds the routing-preference layer. Deep
detail: the conflation README (above) and
[`infra/graphhopper/README.md`](../../infra/graphhopper/README.md).

Starts **CZ-only** (GraphHopper imports the Czech extract). Extending to cz/sk/at
means importing a **merged** extract (`osmium merge`) — the same one-merged-file
rule as Valhalla — and is a later step.

**Prerequisites**

- The road import is live and `road_segments` is populated (above).
- A **shared volume** both the backend (writer) and the GraphHopper app (reader)
  mount — the conflation output has to land where GraphHopper reads it. Same
  pattern as the road-extract volume between `apps/ingest` and the backend.
  **Ownership (same gotcha as the road-extract volume):** the backend runs as
  **uid 100**, but its image pre-chowns only the POI/FSQ/road-import dirs — **not**
  the conflation output dir. A fresh Coolify volume comes up **root-owned**, so
  the first `quality:conflation` run's temp-write + rename fails with `EACCES`
  before the webhook ever fires. Chown it once after mounting:

  ```bash
  docker exec -u 0 <backend-staging> chown -R 100:101 /data/routing
  ```

  (The conflation writes the output world-readable, so GraphHopper reads it
  regardless of its own uid, and GraphHopper owns its own graph dir
  `/data/default-gh`.)

- Coolify **"Connect To Predefined Network"** on both apps so the backend reaches
  GraphHopper by network alias (see the ingest networking note above).

**1. The routing extract is produced by `road:refresh` — no manual step.** The
conflation INPUT is a whole-network `<code>.osm` of the **drivable highways plus
`route=ferry` ways** (GraphHopper routes ferries), and the ingest `road:refresh`
now writes it (its own `osmium tags-filter` of the region PBF — routable-sized,
not the ~12 GB full country) when `TARMOTO_OSM_ROAD_ROUTING_DIR` is set. On
**ingest**, alongside the road-refresh env, add:

```bash
TARMOTO_OSM_ROAD_ROUTING_DIR=/data/routing   # its own shared dir (≠ the tile dir)
```

`road:refresh` then writes `/data/routing/cz.osm` next to the tiles. The backend
conflation reads it as `TARMOTO_QUALITY_CONFLATION_INPUT_FILE=/data/routing/cz.osm`
and writes `TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE=/data/routing/cz.quality.osm`,
which GraphHopper imports. All three apps mount `/data/routing` (ingest writes the
base `.osm`, backend writes the tagged one, GraphHopper reads it); the images
pre-create it owned by uid 100, but a pre-existing **root-owned** volume still
needs a one-time `chown -R 100:101 /data/routing` (same gotcha as the road-extract
volume).

GraphHopper crash-loops until `cz.quality.osm` exists — it **self-heals** the
moment the first conflation writes it (step 5); no manual seed needed.

**2. Stand up the GraphHopper Coolify app — build it from
[`infra/graphhopper/Dockerfile`](../../infra/graphhopper/Dockerfile).** Coolify's
image apps expose only "Custom Docker Options" (no entrypoint/command field), and
the stock image's entrypoint bakes `-c config-example.yml` with no `-i` and no
cache-clear — so it can't be pointed at our extract as-is. Rather than fight that,
deploy the small custom image: stock `israelhikingmap/graphhopper:10.2` **plus**
our `config.yml` (baked at `/graphhopper/config.yml`, so the `/data` mount can't
hide it — it already lists `smoothness` in `graph.encoded_values`, no engine
change) **plus** a start wrapper
([`start.sh`](../../infra/graphhopper/start.sh)) set as `ENTRYPOINT` that clears
the graph dir (`/data/default-gh` — see the callout below) on each start then
launches GraphHopper against `/data/routing/cz.quality.osm`. Point the Coolify app at this repo with the
**Dockerfile build pack** (build context `infra/graphhopper`), or build + push the
image to a registry the app pulls from.

- **Persistent storage** — mount the **shared routing volume at `/data/routing`**,
  the SAME path ingest + backend use (step 1), so `cz.osm`/`cz.quality.osm` resolve
  to `/data/routing/*` for all three apps. ⚠️ Mounting that same volume at a
  DIFFERENT depth here (e.g. `/data`) puts the files at `/data/cz.quality.osm`
  inside GraphHopper while its config reads `/data/routing/…`, so it keeps
  crash-looping — use the identical path everywhere. GraphHopper's graph cache
  (`/data/default-gh`) is **separate** — its own storage, NOT the routing volume
  (a volume mounted at `/data`, or left unpersisted so every restart re-imports —
  simplest for staging). `config.yml` is baked into the image, on neither.
- **Port** 8989. **Env** `JAVA_OPTS=-Xms1g -Xmx4g` (a CZ import peaks ~4–5 GB —
  size the app + swap accordingly).
- **Network alias** e.g. `tarmoto-graphhopper`.

The baked start clears the graph dir every boot, so the first start imports
(slow, one-time) and every redeploy re-imports the latest conflated extract —
which is what makes a plain Coolify redeploy the re-import receiver (step 4). No
entrypoint/command override or `--entrypoint` docker option needed.

> **The graph lives in `/data/default-gh`, not `graph-cache`.** The image's
> `graphhopper.sh` always forces the graph location to its `GRAPH` default
> `/data/default-gh` unless `-o` is passed — and neither the stock entrypoint nor
> our `start.sh` passes `-o` (so both agree). So every cache clear (start.sh's,
> and the manual one in the re-import note below) must target `/data/default-gh`;
> clearing `graph-cache` would be a no-op and leave a stale graph.

**3. Wire the backend (Coolify env), then redeploy.**

```bash
TARMOTO_GRAPHHOPPER_BASE_URL=http://tarmoto-graphhopper:8989   # route via staging GH
TARMOTO_GRAPHHOPPER_TOLL_ENABLED=true                          # self-hosted defaults toll OFF; keep avoidTolls working
TARMOTO_GRAPHHOPPER_TIMEOUT_MS=45000                           # hard deadline per upstream route
TARMOTO_GRAPHHOPPER_MAX_CONCURRENCY=2                         # protect a small shared routing VPS
TARMOTO_GRAPHHOPPER_CACHE_TTL_MS=120000                       # lets Save reuse the approved preview
TARMOTO_GRAPHHOPPER_CACHE_MAX_ENTRIES=64                      # bounded process-local cache; long polylines are large
TARMOTO_ROUTE_ENRICHMENT_MAX_CONCURRENCY=3                    # 3 aggregates × 3 SQL queries ≈ 9 pool slots
TARMOTO_QUALITY_CONFLATION_ENABLED=true
TARMOTO_QUALITY_CONFLATION_INPUT_FILE=/data/routing/cz.osm
TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE=/data/routing/cz.quality.osm
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL=<the GraphHopper app's Coolify deploy webhook>
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD=GET                # Coolify deploy hook
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_TOKEN=<if the hook needs one>
TARMOTO_GRAPHHOPPER_QUALITY_ENABLED=true                       # request-time: USE the smoothness
```

The backend must mount the **same** shared volume at the path holding
`cz.osm`/`cz.quality.osm`.

**4. The re-import receiver.** GraphHopper has no reload API and reuses the
existing graph (`/data/default-gh`) on restart, so after a conflation something
must **clear `/data/default-gh` and restart** it, or the fresh smoothness never
reaches the graph.

A plain **Coolify redeploy webhook** (`METHOD=GET`) is sufficient **only if the
image's `start.sh` ENTRYPOINT is actually running** — that's what does the
`rm -rf /data/default-gh` on each start. **Verify that before relying on it:** run
a conflation, let the redeploy fire, and confirm GraphHopper logs a fresh **import**
(not just a graph _load_). If it only loads the existing graph, the stock
`graphhopper.sh` entrypoint is running (Coolify isn't honouring the ENTRYPOINT, or
a leftover `--entrypoint` custom docker option is overriding it), so the redeploy
does **not** clear the graph and quality routes silently go stale.

In that stock-entrypoint case the receiver must clear the graph itself:

- **Fix the ENTRYPOINT** (preferred) — remove any leftover `--entrypoint` custom
  docker option so the image's `start.sh` runs; then the plain redeploy hook works
  as above. Or
- **Clear-then-redeploy** — point the webhook at a small sidecar (or a manual
  step) that runs `rm -rf /data/default-gh` on the shared volume **before**
  triggering the GraphHopper redeploy.

A non-2xx/unreachable webhook makes the conflation job throw (BullMQ retries), so
a broken hook is visible; but a redeploy that succeeds **without** clearing the
graph is silent — hence the verify step above.

**5. Enablement order + first run** — the whole pipeline, no manual upload:

1. **ingest** — `TARMOTO_OSM_ROAD_ROUTING_DIR` set + `road:refresh` run once
   (scheduled task or `docker exec … node apps/ingest/dist/scripts/refresh-road-extracts.js`)
   → writes `/data/routing/cz.osm` alongside the tiles. Confirm `cz.osm` landed.
2. **backend** — env set (step 3) + redeployed; `road:import` (the Sunday cron, or
   `docker exec <backend> node apps/backend/dist/scripts/road-import.js`) →
   `road_segments` populated.
3. **backend** — produce the first tagged extract on demand rather than waiting
   for the next import tick:
   ```bash
   docker exec <backend-staging> node apps/backend/dist/scripts/quality-conflation.js
   ```
   It reads `/data/routing/cz.osm` + `road_segments`, writes
   `/data/routing/cz.quality.osm`, then fires the re-import webhook.
4. **GraphHopper** — now that `cz.quality.osm` exists it imports it and comes up
   serving on 8989 (it was crash-looping until this point — self-healed). Every
   subsequent road import chains the conflation automatically.

**6. Validate — [ADR-0005](../decisions/0005-road-quality-routing-via-smoothness.md)
acceptance.** Find a low-quality road on a routable corridor:

```sql
SELECT osm_way_id, quality_score FROM road_segments
WHERE osm_way_id IS NOT NULL AND quality_score < 2 ORDER BY reading_count DESC LIMIT 20;
```

Route a path that would otherwise use it, once with `preferQuality` **off**
(baseline) and once **on** — the `preferQuality` route should **detour around**
the low-quality road. That divergence is the proof the whole chain — conflation →
GraphHopper re-import → request-time weighting — is live.

**Not before production.** Enabling this for a live **prod** region waits on
**#809** (aggregate-safe road detail); dev/staging may enable it freely.

## Stripe billing go-live

Billing is code-complete and configuration-driven. Enabling it in an environment
is populating five variables and registering one webhook — no deploy-time code
change. Until they are set, checkout and the portal return
`503 Billing is not configured` and no subscription webhook is processed.

### 1. Environment variables

| Variable                                 | Required | Notes                                                                               |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `TARMOTO_STRIPE_SECRET_KEY`              | yes      | `sk_live_…` in production                                                           |
| `TARMOTO_STRIPE_WEBHOOK_SECRET`          | yes      | the `whsec_…` for THIS environment's endpoint — it is per-endpoint, not per-account |
| `TARMOTO_STRIPE_PRO_PRICE_ID`            | yes      | `price_…` for the mid tier (€29.99)                                                 |
| `TARMOTO_STRIPE_PREMIUM_PRICE_ID`        | yes      | `price_…` for the top tier (€49.99)                                                 |
| `TARMOTO_STRIPE_PORTAL_CONFIGURATION_ID` | no       | only for retention / cancellation deflection                                        |

Two further billing knobs exist for the store-subscription-chains machinery
(#1191). Both have safe defaults and normally stay unset:

| Variable                                | Default | Notes                                                                                                                                         |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARMOTO_BILLING_OVERLAP_FALLBACK_DAYS` | `35`    | how long a store chain with NO known period end stays trusted (entitlement, the rollup expiry and overlap deadlines all share this one bound) |
| `TARMOTO_BILLING_OVERLAP_GRACE_HOURS`   | `72`    | grace past a period boundary before a provisional billing overlap becomes due for its check — must exceed store webhook delivery lag          |

**Set all four required ones together.** A partial configuration is the one
genuinely dangerous state: checkout succeeds, the webhook maps the price to no
tier, and the rider is billed while entitled nothing. `BillingConfigCheck` logs
`Stripe billing is PARTIALLY configured` at boot for exactly this — grep the
deploy output for it.

**Do not paste the same price id into both.** Every required value is then set,
so a presence check calls it healthy — but a Premium purchase is charged at that
price and granted PRO, because `tierFromPrice` matches the pro id first. The
startup check reports this as `are BOTH set to price_…`.

**Mind the tier names.** They were swapped in 2026-07: **pro is the mid tier,
premium is the top tier**, the opposite of the original marketing page. Pointing
these two variables at each other's prices charges every rider the wrong amount.
`tierFromPrice` resolves the configured price IDs _before_ Stripe's
`lookup_key`, so correct env vars override a stale lookup key — but not a
swapped one.

### 2. Webhook endpoint

Point it at `POST {backend}/api/v1/account/billing/webhook` and subscribe to
exactly these four events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Anything else is ignored. Copy that endpoint's signing secret into
`TARMOTO_STRIPE_WEBHOOK_SECRET` — using another endpoint's secret makes every
delivery fail signature verification, which looks identical to an outage.

### 3. Verify before announcing

- Boot log contains **no** `PARTIALLY configured` line.
- A test-mode checkout completes and `/users/me` shows the paid tier.
- Cancel mid-period: the rider **keeps** the tier, `cancel_at_period_end` is set,
  and the tier drops only at period end. (This is asserted in
  `stripe-lifecycle-persisted.e2e-spec.ts`; verifying it live confirms the
  price/lookup-key wiring rather than the logic.)
- Search logs for `maps to NO tier`. That error means a rider is being billed
  and entitled nothing — treat it as an incident, not a warning.

### 4. Turning billing off without a deploy

`sys_billing_checkout` (Admin → System switches) stops **new** checkout sessions
immediately. It deliberately does **not** gate the billing portal: existing
subscribers must always be able to manage or cancel. Trapping paying riders is a
worse failure than the one the switch exists to contain.

It does not stop webhooks. Renewals and cancellations of existing subscriptions
keep being processed, which is what you want — the switch stops taking new money,
it does not abandon riders who already paid.
