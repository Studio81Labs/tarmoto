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
- **Recurring (production):** the weekly BullMQ import cron (scheduler + processor, `poi.import` queue, Sunday 03:00 UTC) runs on the process where `TARMOTO_QUEUE_WORKER_ENABLED=true` — the dedicated worker process in a split API/worker deployment, **not** the API. Set `TARMOTO_POI_IMPORT_ENABLED=true`, `TARMOTO_POI_IMPORT_DIR`, and (optionally) `TARMOTO_POI_IMPORT_REGIONS` **there**; setting them only on the API app has no effect. That worker process also needs `TARMOTO_POI_DATABASE_*` (it writes to the POI DB). Leave `TARMOTO_POI_IMPORT_ENABLED` unset/`false` in dev and CI so they don't run a continent-scale import.

Both paths read the per-region `.osm` files an operator prepares out-of-band; produce them first.

A **second bulk source**, Foursquare OS Places (#869, `source='fsq'`), imports the same way from per-region `.fsq.jsonl` extracts — see [Producing per-country POI extracts (Foursquare OS Places)](#producing-per-country-poi-extracts-foursquare-os-places). It has its own env vars (`TARMOTO_FSQ_IMPORT_ENABLED/DIR/REGIONS`) and CLI (`pnpm fsq:import`), and coexists with OSM in `pois` via the `(source, external_id)` key. **Not prod-safe yet:** store reads filter by `kind`, not `source`, so an imported FSQ row is served immediately alongside OSM — importing to production before the cross-source dedup + Foursquare attribution land would show duplicate pins and miss required credit. Until then, only import FSQ on dev/staging.

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

### Producing per-country POI extracts (Foursquare OS Places)

The FSQ bulk import (#869) reads one **newline-delimited JSON** file per active region from `TARMOTO_FSQ_IMPORT_DIR`, named `<code>.fsq.jsonl` (lower-case ISO code, e.g. `cz.fsq.jsonl`). It's a second `source` (`'fsq'`) stored alongside OSM in `pois`; it uses [FSQ OS Places](https://docs.foursquare.com/data-products/docs/access-fsq-os-places) — the free, Apache-2.0, monthly-refreshed open dataset — **not** the Places API (the API's ToS forbids bulk-storing its data; OS Places is built for it).

OS Places ships as Parquet on S3 (100M+ rows). We keep the huge download + filter **offline** (like the osmium step above), so the backend only ever streams a small per-region extract and no FSQ credential reaches production. An operator runs a DuckDB recipe once per refresh:

Per region:

1. **Get a token.** Create a free [FSQ Places Portal](https://docs.foursquare.com/data-products/docs/access-fsq-os-places) account and generate S3 credentials — they're **short-lived (~1 month)**, so regenerate each refresh (which lines up with the dataset's monthly cadence).
2. **Filter with DuckDB** to the region's `DEFAULT_REGIONS` bbox + `date_closed IS NULL` + a coarse category prefilter, joining the FSQ category arrays to comma strings, and write NDJSON. The backend classifier (`fsq-poi-categories.ts`) does the precise category → `kind` mapping, so the SQL prefilter only needs to be a loose superset.
3. **Place** the result in `TARMOTO_FSQ_IMPORT_DIR` as `<code>.fsq.jsonl`.

**Worked example — Czech Republic (`CZ`):**

```sql
-- duckdb (INSTALL httpfs; LOAD httpfs;)
SET s3_region='us-east-1';
SET s3_access_key_id='…';       -- from the FSQ Places Portal (regenerate monthly)
SET s3_secret_access_key='…';

COPY (
  SELECT
    fsq_place_id, name, latitude, longitude,
    array_to_string(fsq_category_ids, ',')    AS category_ids,
    array_to_string(fsq_category_labels, ',') AS category_labels,
    tel, website, address, locality, postcode, country
  FROM read_parquet('s3://fsq-os-places-us-east-1/release/dt=<YYYY-MM-DD>/places/parquet/*.parquet')
  WHERE date_closed IS NULL
    -- CZ bbox from DEFAULT_REGIONS (minLng,minLat,maxLng,maxLat = 12.09,48.55,18.86,51.06)
    AND longitude BETWEEN 12.09 AND 18.86
    AND latitude  BETWEEN 48.55 AND 51.06
    -- coarse category superset; the backend classifier is authoritative
    AND len(list_filter(fsq_category_labels, x -> regexp_matches(lower(x),
        'restaurant|caf|coffee|food|ice cream|gas|petrol|fuel|charging|lookout|viewpoint|overlook|rest area|hotel|motel|hostel|inn|guest|apartment|camp|resort|cottage|chalet|cabin|caravan|breakfast'))) > 0
) TO '<TARMOTO_FSQ_IMPORT_DIR>/cz.fsq.jsonl' (FORMAT json);
```

Then import — on demand `pnpm fsq:import` (all configured regions) or `node dist/scripts/import-pois.js fsq CZ` (one region); it bypasses the enabled gate like `poi:import`. For recurring runs set `TARMOTO_FSQ_IMPORT_ENABLED=true`, `TARMOTO_FSQ_IMPORT_DIR`, and (optionally) `TARMOTO_FSQ_IMPORT_REGIONS=CZ` on the worker process (unset imports all 17), alongside `TARMOTO_POI_DATABASE_*`. The extract dir and region list are independent of the OSM import's.

> ⚠️ **Dev/staging only until FSQ is prod-safe.** As noted above, store reads don't filter by `source`, so imported FSQ rows go live immediately. Do not import FSQ to production until the cross-source OSM↔FSQ dedup and the Foursquare attribution ship (the "enable FSQ" follow-up on #869).
