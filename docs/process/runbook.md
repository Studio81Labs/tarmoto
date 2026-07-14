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

`workflow_dispatch` on `backend-deploy.yml` lets an operator pick either environment (the input is checked **before** the tag ref, so a dispatch from a `v*` tag selecting "staging" still deploys staging).

### What a backend deploy does

`backend-deploy.yml` (single "Deploy & verify" job, `environment:` = the resolved env):

1. **Resolve environment** — `main` push → `staging`, `v*` tag → `production`, else the dispatch input.
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
3. The tag push runs `backend-deploy.yml` with the `production` environment → stamps the version → triggers the Coolify deploy API → tracks the deployment to `finished` → healthcheck against `api.tarmoto.app` → `scripts/smoke/smoke.sh`.
4. The same `v*` tag fans out to every surface: `companion-deploy.yml` and `marketing-deploy.yml` resolve the `production` target on `v*`, and `mobile-release.yml` builds + submits the app to TestFlight / Play Internal (deriving the version from the tag). One tag ships backend, companion, marketing, and mobile at the same commit. Accepted tradeoff: a `v*` tag rebuilds mobile too — for a server-only hotfix, use `workflow_dispatch` on the specific deploy instead of cutting a tag.

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

## Databases & Migrations

### POI database topology

The POI (point-of-interest) database is a **separate PostgreSQL + PostGIS instance** (see [ADR 0007](../decisions/0007-separate-poi-database.md)). It isolates the high-write POI data path from the core backend database, reducing contention and operational risk.

**Local development:**

```bash
pnpm db:up                  # Starts both tarmoto (5433) and tarmoto-poi-db (5434) Compose services
pnpm db:migrate:poi         # Runs POI database migrations
```

**Production:**

Provision a dedicated Coolify Postgres instance (separate from the core backend database). Set the following on the backend Coolify application:

- `TARMOTO_POI_DATABASE_HOST`
- `TARMOTO_POI_DATABASE_PORT`
- `TARMOTO_POI_DATABASE_NAME`
- `TARMOTO_POI_DATABASE_USER`
- `TARMOTO_POI_DATABASE_PASSWORD`

**PostGIS must be available in the POI database.** The POI migration lineage runs `CREATE EXTENSION IF NOT EXISTS postgis` before creating spatial columns, so `TARMOTO_POI_DATABASE_USER` needs privileges to create extensions — otherwise a superuser must install PostGIS in the POI database once, up front, before `pnpm db:migrate:poi`. (Locally the `postgis/postgis` image does this automatically, which is why dev never hits it.)

### POI database resilience

The backend **tolerates the POI database being unavailable**. When the POI DB is down:

- POI store reads return `503 Service Unavailable`.
- `GET /poi/health` reports `{ poiDb: 'down' }` (while the rest of the app status remains healthy).
- The rest of the backend stays operational; trips, users, and ride data are unaffected.

This design allows POI data maintenance (migrations, backups, maintenance windows) without blocking core app traffic.

### Populating the POI store

The POI store starts empty; store read endpoints return an empty result (not an error) for regions that have not been imported yet. The store is filled from **per-country Geofabrik `.osm` extracts** (produced with `osmium tags-filter` — see [Producing per-country POI extracts](#producing-per-country-poi-extracts)), **not** a live Overpass bbox: bulk extracts scale to the full 17-country coverage list without hitting the Overpass public-API limits. Overpass stays the live read-path fallback (`poi.service`), never the bulk importer. Two ways to fill the store:

- **On demand:** `pnpm poi:import` runs the import once over the configured regions (`TARMOTO_POI_IMPORT_REGIONS`, default all 17) from the extracts in `TARMOTO_POI_IMPORT_DIR`. It writes to the POI database and bypasses the `TARMOTO_POI_IMPORT_ENABLED` gate, so a one-off run doesn't need the flag flipped.
- **Recurring (production):** the weekly BullMQ import cron (scheduler + processor, `poi.import` queue, Sunday 03:00 UTC) runs on the process where `TARMOTO_QUEUE_WORKER_ENABLED=true` — the dedicated worker process in a split API/worker deployment, **not** the API. The weekly dispatch fans out over **every enabled source** (#869): it enqueues one staggered per-region job for each source whose `TARMOTO_<SOURCE>_IMPORT_ENABLED` is set, so OSM and FSQ refresh from the same weekly tick. Set `TARMOTO_POI_IMPORT_ENABLED=true`, `TARMOTO_POI_IMPORT_DIR`, and (optionally) `TARMOTO_POI_IMPORT_REGIONS` **there** for OSM (and the `TARMOTO_FSQ_IMPORT_*` trio for FSQ); setting them only on the API app has no effect. That worker process also needs `TARMOTO_POI_DATABASE_*` (it writes to the POI DB). Leave every `*_IMPORT_ENABLED` unset/`false` in dev and CI so they don't run a continent-scale import.
- **Admin UI (#847):** operators can upload an extract + trigger a per-region import from the admin app (`/admin/poi`) instead of placing files + running the CLI. **Critical for a split API/worker deployment:** the upload writes the extract to `TARMOTO_*_IMPORT_DIR` on the **API** process, but the import job runs on the **worker** — so that directory MUST be **shared storage mounted in both the API and worker containers** (a shared volume). Without it the admin page shows the extract "present" (read from the API's filesystem) while the worker's import can't see the file and records a **skipped** run. That skip is visible in the admin run history (so it isn't silent), but a shared mount is required for the admin upload→import flow to work at all. If the extract dir isn't configured on the API, the upload returns a clear 503. **Volume ownership:** the image creates each configured `TARMOTO_*_IMPORT_DIR` (OSM **and** FSQ — independent paths) owned by the non-root `tarmoto` user, so a **fresh** named volume mounted there comes up writable. A volume that already exists **root-owned** (provisioned before this) must be `chown tarmoto:tarmoto`'d once (or recreated), or uploads fail with `EACCES`; if OSM and FSQ use **separate** volumes, each needs it. _(Follow-up: move extracts to worker-visible object storage to drop the shared-mount requirement.)_

Both paths read the per-region `.osm` files an operator prepares out-of-band; produce them first.

A **second bulk source**, Foursquare OS Places (#869, `source='fsq'`), imports the same way from per-region `.fsq.jsonl` extracts — see [Producing per-country POI extracts (Foursquare OS Places)](#producing-per-country-poi-extracts-foursquare-os-places). It has its own env vars (`TARMOTO_FSQ_IMPORT_ENABLED/DIR/REGIONS`) and CLI (`pnpm fsq:import`), coexists with OSM in `pois` via the `(source, external_id)` key, and is now included in the weekly cron (above) when `TARMOTO_FSQ_IMPORT_ENABLED=true`. Cross-source de-dup has landed (#932), so an imported FSQ row no longer double-pins an OSM venue. **Still not prod-safe:** store reads filter by `kind`, not `source`, so an imported FSQ row is served immediately, and Apache-2.0 requires visible Foursquare attribution — which isn't wired into the companion yet. Until attribution lands, only import FSQ on dev/staging.

### Region-coverage boundaries (#944)

Store reads are **coverage-aware**: `PoiService.readStoreFirst` treats an empty
store result as authoritative (skips the Overpass fallback) only when the request
falls inside an **imported region's boundary polygon**, and merges Overpass at the
import frontier otherwise. That decision (`PoiStoreService.isRequestCovered`) runs
`ST_Covers(region_polygon, request)` against the `poi_import_regions` table, gated
on `imported_at IS NOT NULL`.

- **One-time (and whenever the asset changes):** `pnpm poi:load-boundaries` loads
  the 17 country boundary polygons (Natural Earth 1:50m, committed at
  `apps/backend/src/assets/import-region-boundaries.geojson`) into
  `poi_import_regions`. Run it **after** `pnpm db:migrate:poi`; it needs
  `TARMOTO_POI_DATABASE_*` where you run it. Idempotent (`ON CONFLICT (code)`),
  and it never resets `imported_at`.
- **`imported_at` is stamped by the OSM import:** a region counts as covered only
  once `pnpm poi:import` (OSM) has successfully imported it — the importer stamps
  `poi_import_regions.imported_at` for that region (FSQ imports do **not** stamp,
  since the fallback this gates is OSM-backed). So the deploy/refresh order is
  `db:migrate:poi` → `poi:load-boundaries` (once) → `poi:import`.
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

The bulk POI import reads one `.osm` XML file per active region from `TARMOTO_POI_IMPORT_DIR`, named `<code>.osm` (lower-case ISO 3166-1 alpha-2, e.g. `cz.osm`). An operator prepares each file once per refresh from the country's Geofabrik download, mirroring the roads OSM importer's prep (`../../apps/backend/src/modules/roads/osm-import/README.md`). The importer reads `.osm` XML, not `.osm.pbf` directly — the maintained JS PBF parsers are stale; osmium decodes PBF far better.

Per country:

1. **Download** the Geofabrik per-country `<country>-latest.osm.pbf`.
2. **`osmium tags-filter`** down to the §7 POI tag set (fuel, food incl. `fast_food`, accommodation, viewpoints, rest areas, ice cream) — a small fraction of the country file.
3. **`osmium extract -b`** to the region's **authoritative bbox** from `DEFAULT_REGIONS` (`../../apps/backend/src/modules/poi/poi-import.config.ts`), writing `.osm` XML.
4. **Place** the result in `TARMOTO_POI_IMPORT_DIR` as `<code>.osm`.

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
  -o "$TARMOTO_POI_IMPORT_DIR/cz.osm"
```

Repeat per country in the active set, each clipped to its own `DEFAULT_REGIONS` bbox. Then enable the import on the worker process: `TARMOTO_POI_IMPORT_ENABLED=true`, point `TARMOTO_POI_IMPORT_DIR` at the folder of `.osm` files, and narrow coverage with `TARMOTO_POI_IMPORT_REGIONS` (e.g. `CZ,SK,AT`); unset imports all 17.

**Validate volume + runtime before enabling all regions in production (#850 acceptance criterion).** Region-wide the filtered set is low millions of rows; `pois` is GiST-indexed on `geom` and GIN-indexed on `tags` (plus the `(source, external_id)` unique and `(address_country, kind)` browse index), so store reads stay bounded — but the import's fetch/upsert cost and the worker's memory/runtime scale with coverage. Bring regions online **incrementally**: validate per-country row counts and a full-run wall-clock on staging before flipping all 17 on in production at once.

#### Automating the OSM refresh (scheduled container, #976)

The manual steps above (download → `tags-filter` → clip → place) can run
automatically so the weekly import mirrors **current** data instead of
re-importing a static file. `apps/backend/Dockerfile.poi-refresh` builds a small
osmium + node image whose one-shot entrypoint (`pnpm poi:refresh` →
`dist/scripts/refresh-poi-extracts.js`) runs exactly that per-country pipeline
for every configured region, writing each `<code>.osm` **atomically** to
`TARMOTO_POI_IMPORT_DIR`.

It's kept **separate** from the backend/worker image on purpose — osmium and
multi-GB PBF handling don't belong in the app runtime — but reuses the backend
build, so the clip bbox comes straight from `DEFAULT_REGIONS` and can't drift.
Region set + target dir are the **same** env as the importer
(`TARMOTO_POI_IMPORT_REGIONS` / `TARMOTO_POI_IMPORT_DIR`); the Geofabrik country
slugs live in `poi-refresh.config.ts` (a spec asserts every region has one).

Operate it as a **scheduled task** (Coolify scheduled task / cron), timed to
finish comfortably **before** the Sunday 03:00 UTC import tick (e.g. Saturday):

- `TARMOTO_POI_REFRESH_ENABLED=true` — off by default; the container is a no-op
  otherwise.
- Mount the **same shared extract volume** at `TARMOTO_POI_IMPORT_DIR` that the
  API/worker read. One refresh container can feed **both staging and prod** from
  a single shared volume — the `<code>.osm` files are environment-agnostic
  (filtered OSM), so producing them once avoids duplicating the (multi-GB) set
  per environment. Every party that touches the volume — this container, the
  staging backend, the prod backend — runs as **uid 100** (the image pins it to
  match the backend `tarmoto` and the volume owner), so writes here are readable
  by, and replaceable by, all of them. (A corollary of one shared volume: an
  admin upload on one environment lands the same file every environment then
  imports — intended here, but worth knowing.)
- (optional) `TARMOTO_POI_IMPORT_REGIONS` to refresh a subset.
- Ephemeral disk for the largest single country PBF (~4 GB for DE) plus its
  filtered copy — regions run sequentially and clean up between, so peak disk is
  one country, not all 17.

Behaviour:

- **Atomic + keep-last-good:** each extract is built at a sibling `.part` file
  and only renamed onto `<code>.osm` after every step succeeds. A failed
  download/filter/clip leaves the previous good extract untouched (never a
  truncated file) and the run continues to the next region.
- **Observable:** the container exits **non-zero** if any region failed (so the
  scheduler can alert), and logs every region's outcome. The next import simply
  re-imports whatever landed — a region whose refresh failed re-imports its prior
  extract.

The manual pipeline above stays the fallback (one-off refresh, a region with no
Geofabrik slug, or before the scheduled container is provisioned). **FSQ is not
automated** — OS Places is a token-gated DuckDB/Iceberg pull (below); refresh it
via the manual recipe.

### Producing per-country POI extracts (Foursquare OS Places)

The FSQ bulk import (#869) reads one **newline-delimited JSON** file per active region from `TARMOTO_FSQ_IMPORT_DIR`, named `<code>.fsq.jsonl` (lower-case ISO code, e.g. `cz.fsq.jsonl`). It's a second `source` (`'fsq'`) stored alongside OSM in `pois`; it uses [FSQ OS Places](https://docs.foursquare.com/data-products/docs/access-fsq-os-places) — the free, Apache-2.0, monthly-refreshed open dataset — **not** the Places API (the API's ToS forbids bulk-storing its data; OS Places is built for it).

OS Places is delivered through the **Foursquare Places Portal** as a token-gated **Iceberg catalog** (the legacy public S3 Parquet bucket is deprecated). We keep the query + filter **offline** (like the osmium step above), so the backend only ever streams a small per-region extract and no FSQ credential reaches production. An operator runs a DuckDB recipe once per refresh:

Per region:

1. **Get a token.** Create a free [FSQ Places Portal](https://places.foursquare.com/) account and generate an access token — it's **short-lived (~1 month)**, so regenerate each refresh (which lines up with the dataset's monthly cadence).
2. **Connect DuckDB to the Iceberg catalog** with the connection snippet the Portal generates for your token (it attaches the catalog exposing the `places` table; needs DuckDB's `iceberg` extension). Those details are token/catalog-specific — copy them from the Portal, don't hardcode them here.
3. **Filter** to the region's **ISO-2 country** + its `DEFAULT_REGIONS` bbox + `date_closed IS NULL` + a coarse category prefilter, joining the FSQ category arrays to comma strings, and write NDJSON. The country predicate is essential — `places` is a global table, so bbox alone pulls in cross-border neighbours (the importer would then mis-own them). The backend classifier (`fsq-poi-categories.ts`) does the precise category → `kind` mapping, so the SQL category prefilter only needs to be a loose superset.
4. **Place** the result in `TARMOTO_FSQ_IMPORT_DIR` as `<code>.fsq.jsonl`.

**Worked example — Czech Republic (`CZ`)** — once the Portal's connect snippet (step 2) has attached the catalog, the filter/export is:

```sql
-- After the Portal's DuckDB connect snippet attaches the `places` table
-- (INSTALL iceberg; LOAD iceberg; + the Portal's ATTACH, per your token).
COPY (
  SELECT
    fsq_place_id, name, latitude, longitude,
    array_to_string(fsq_category_ids, ',')    AS category_ids,
    array_to_string(fsq_category_labels, ',') AS category_labels,
    tel, website, address, locality, postcode, country
  FROM places
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
) TO '<TARMOTO_FSQ_IMPORT_DIR>/cz.fsq.jsonl' (FORMAT json);
```

Then import with the **manual CLI** — `pnpm fsq:import` (all configured regions from `TARMOTO_FSQ_IMPORT_DIR`, narrowed by `TARMOTO_FSQ_IMPORT_REGIONS`, default all 17) or `node dist/scripts/import-pois.js fsq CZ` (one region). It bypasses the enabled gate like `poi:import`, and needs `TARMOTO_POI_DATABASE_*` where you run it. FSQ's extract dir + region list are independent of OSM's.

**Weekly FSQ cron.** The weekly BullMQ dispatch (§ above) now fans out over every enabled source, so setting `TARMOTO_FSQ_IMPORT_ENABLED=true` (plus `TARMOTO_FSQ_IMPORT_DIR`) on the worker process refreshes FSQ from the same Sunday tick as OSM — each source gated independently by its own `*_IMPORT_ENABLED`. The manual `fsq:import` CLI stays available for one-off runs.

**Prod-safe as of the attribution work (#869).** Both prior gates are met: cross-source OSM↔FSQ dedup landed (#932), and the companion now credits Foursquare **data-driven** — the map info bar (latched on once FSQ POIs appear), the stops-tab legend (a blue Foursquare dot while FSQ stops are present), and each FSQ POI's popover (`© Foursquare`). The Apache-2.0 / NOTICE.txt attribution is preserved below. FSQ stays **disabled by default** (`TARMOTO_FSQ_IMPORT_ENABLED` unset); enable it per environment when its extracts are provisioned.

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
