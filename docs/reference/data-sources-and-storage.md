# Data Sources & Storage Reference

> The data Tarmoto needs so the **map can render it** and the **route builder can use it** — what each datum is, where it comes from, how it's stored, how often it refreshes, and when it expires.
>
> For product behavior see [../specs/tarmoto-product-spec.md](../specs/tarmoto-product-spec.md). For the system map see [architecture.md](architecture.md). For the live schema see [../database/schema.sql](../database/schema.sql).

This reconciles the early data-sourcing notes against the schema that **already exists** in `apps/backend/src/entities/`. Where a sourcing note invented a name (`road_events`, `road_quality`, `sensor_raw`, `pois`), the real table is given. The app is pre-production, so breaking changes are fine — this describes the target, not a compatibility contract.

---

## The two consumers

Everything below exists to feed one or both of these:

| Consumer          | Reads                                                                                                    | Served by                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Map layer**     | segment quality/surface/curviness, hazards, closures, fun zones, POIs                                    | `tiles.service` (vector MVT tiles) + GeoJSON overlays                             |
| **Route builder** | base routing graph, closures-to-avoid, per-segment quality/curviness/surface for scoring, POIs for stops | `RoutingProvider` (OSRM today, Valhalla-ready) + `trip-generator.service` scoring |

A datum only belongs in this document if it reaches one of those two. Account, social, and ride-history data are out of scope here (see the schema).

---

## 1. Static base & reference (OSM-derived)

Public base data. Slow refresh, overwritten in place, **no row-level expiry**.

| Datum                                                       | Real table / module                                                | Source                                      | Storage                                  | Refresh                            | TTL  | Notes                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------- | ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Road segments (geometry, name/number, length, ~100 m split) | `road_segments`                                                    | OpenStreetMap                               | PostGIS                                  | Weekly–monthly re-import           | none | Stable internal UUIDs kept across re-imports                                                                                                           |
| Curviness                                                   | `road_segments.curviness_score`                                    | Computed from OSM geometry                  | PostGIS                                  | Recompute on OSM refresh           | none | Radius-weighted; drives the "fun roads" map filter + route scoring                                                                                     |
| Surface **type** (asphalt/gravel/…) — seed                  | `road_segments.surface_type`                                       | OSM `surface` tag + HeiGIT pavedness (seed) | PostGIS                                  | OSM cycle / on dataset release     | none | Seed only; overwritten by sensor-derived value (§2)                                                                                                    |
| POIs (fuel, food, viewpoints, accommodation)                | **MVP: live via `overpass.provider`** · post-MVP: `pois` (PostGIS) | Overpass (OSM) + Overture gap-fill          | MVP: none (per request) · later: PostGIS | MVP: live · later: periodic import | none | MVP keeps POIs external — planner stop suggestions only. Stored import lands **with offline packs** to enable offline POIs + a POI map layer. See §8.3 |
| Fun zones (twisty-road clusters)                            | `fun_zones` + `fun_zone_road`                                      | Computed from `road_segments` curviness     | PostGIS                                  | Recompute on segment refresh       | none | See [fun-zone-clustering.md](fun-zone-clustering.md)                                                                                                   |

---

## 2. Crowdsourced & proprietary — the moat

Our own data. Nothing here is bought; this is the defensible asset. Quality is **denormalized onto `road_segments`**, not a separate table.

| Datum                                                                                        | Real table                                                                             | Source                           | Storage                                      | Refresh                           | TTL                                                                                                             | Notes                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Raw per-window sensor readings (IRI, vibration, classification, device/calibration metadata) | `surface_readings`                                                                     | Rider devices                    | PostGIS (+ raw 50 Hz to object store/ingest) | Per ride upload                   | Prune raw windows after a fixed window; **aggregates kept**                                                     | Anonymisable; carries no quality decision itself |
| Aggregated road quality + confidence                                                         | `road_segments.quality_score`, `.confidence`, `.reading_count`, `.last_filtered_count` | Pipeline over `surface_readings` | PostGIS                                      | Re-aggregate continuously/nightly | none — **recency-weighted** (old passes decay in _weight_, not deleted)                                         | The core asset; overwrites the surface seed      |
| Hazard reports (pothole, gravel, oil, animal, police)                                        | `hazard_reports`                                                                       | Users (one-tap)                  | PostGIS (+ Redis push fan-out)               | Real-time                         | **`expires_at` time-decay unless re-confirmed** (`is_active`, `confirmations`, `confirmed_at` already modelled) | Indexed `(is_active, expires_at)`                |
| Road ratings + reviews                                                                       | `road_reviews` + `road_review_vote`                                                    | Users                            | PostGIS (+ object store for photos)          | On submit                         | none                                                                                                            | User-owned; honour deletion                      |

---

## 3. Dynamic external events

Live, short-lived, must reconcile + expire. **This is the layer with no ingestion yet.**

| Datum                                                         | Real table                                              | Source                                                                       | Storage                                   | Refresh                                      | TTL                                                                                                                       | Notes                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Road closures / roadworks / incidents                         | `road_closures` (`source: operator \| osm \| official`) | Operator (now) + **Czech NAP/NDIC DATEX II (`official`) — NOT YET INGESTED** | PostGIS                                   | Operator: on submit. NAP: poll ~3 min        | Deactivate when absent from snapshot **or** `ends_at < now`; keep history for audit — **requires new columns (see §8.1)** | Feeds both the map overlay and route avoidance. See §6 + §8.1                 |
| Weather **samples** (severe conditions at a rider position)   | none — in-memory per-sweep cache                        | OpenWeatherMap                                                               | none (memoised ~1 km cell per sweep tick) | Severe-weather sweep every 15 min            | Ephemeral (lives only for the tick)                                                                                       | Not persisted; not a map layer                                                |
| Weather alert **dispatch ledger** (per-(user, kind) cooldown) | `weather_alert_dispatches`                              | Derived (one row per push sent)                                              | **PostGIS**                               | Written after each push; read before sending | **60-min cooldown** per (user, kind); rows retained (prune later)                                                         | Stops a rider being re-paged inside one storm cell — **persisted, not Redis** |

> **Why `road_closures`, not a new `road_events` table:** the entity already documents `source` as `operator | osm | official` for exactly this — "future sources (OSM, official feeds) populate the same table." The NAP scraper must write here with `source='official'`, mapping NDIC categories → the existing `reason` / `severity` enums.

---

## 4. TTL at a glance — four regimes

The single most-confused thing. Every datum above falls into exactly one:

1. **Recompute, no row TTL** — segment enrichment (`quality_score`, `curviness_score`, `surface_type`). Rebuilt from sources; quality is **recency-weighted** (old passes lose weight, never deleted).
2. **Reconcile + expire** — `road_closures` from NAP. Poll ~3 min; a snapshot is the _full_ current truth, so absent ⇒ `active=false`; also expire when `ends_at < now`. History retained.
3. **Time-decay** — `hazard_reports`. **Already a contract, not a proposal:** per-type base from `EXPIRY_HOURS` (pothole & roadworks 72 h; gravel, flooding, ice 48 h; oil_spill, animals, police, other 24 h), and `HazardsService.confirm()` extends `expires_at` by **+24 h per distinct confirmer** (not a reset). A sweep deactivates when `expires_at < now`.
4. **Ephemeral** — weather _samples_ (per-sweep, never persisted) and live group location (Redis, seconds). Note the weather **dispatch ledger** is the exception — it's a persisted Postgres cooldown record, not ephemeral (see §3).

Plus **slow refresh, no TTL** for the static base (§1): weekly–monthly OSM/Overture re-import, overwrite in place.

---

## 5. How the map consumes this

`tiles.service` bakes Mapbox Vector Tiles with these layers (already implemented):

- `quality` — `road_segments.quality_score` + `surface_type` + `curviness_score` (client filters on all three)
- `surface` — `road_segments.surface_type` + `curviness_score`
- `hazards` — `hazard_reports` (active only)

Overlays served as GeoJSON on top of the tiles:

- **Closures** — `road_closures` active-on-now (the `closures` module already serves these)
- **POIs** — _post-MVP_ (needs the stored `pois` table). MVP serves POIs only as live planner stop suggestions, not a pannable map layer.
- **Fun zones** — `fun_zones` polygons

---

## 6. How the route builder consumes this

- **Base graph** — `RoutingProvider` abstraction (`routing-provider.interface.ts`), OSRM today, Valhalla-ready. Versioned so cached polylines invalidate on engine swaps.
- **Preference scoring** — `trip-generator.service` already scores candidate routes by **curviness**, **surface mix**, and a **quality filter** per segment. This is the per-segment moat data driving route _selection_.
- **Avoidance** — `RoutingOptions` currently exposes only `avoidHighways` / `avoidTolls`.

**Gap (see §8.2):** closures are _checked_ (`closures.checkRoute()` warns that a route crosses one) but **not avoided** — there is no `exclude_polygons` path from `road_closures` into route generation. Buffered closure geometry → `exclude_polygons` is the missing wiring; the scraper example demonstrates the exact output shape.

---

## 7. External source catalog

Sourcing detail for the feeds above. Endpoints, licenses, and the CZ launch bbox.

### POIs — OpenStreetMap via Overpass

- Endpoint: `https://overpass-api.de/api/interpreter` (self-host from a Geofabrik extract for production volume).
- CZ/Beskydy starter bbox (Overpass order `south,west,north,east`): `49.30, 18.00, 49.75, 18.90`.
- Tags: fuel `amenity=fuel`; accommodation `tourism=hotel|guest_house|motel|hostel|chalet|apartment`; food `amenity=restaurant|cafe|fast_food`; viewpoints `tourism=viewpoint`; rest areas `highway=rest_area|services`; ice cream `amenity=ice_cream`/`shop=ice_cream`.
- **Worldwide gap-fill:** Overture Places (CDLA Permissive v2.0, stable GERS IDs). **Caution:** conflating Overture _into one DB with_ OSM can force ODbL — keep them as separate joinable layers.

### Dynamic events — Czech NAP (NDIC)

- Registry: `https://registr.dopravniinfo.cz` (provider NDIC/ŘSD). Free, requires registration. Format: DATEX II (XML).
- **Start with the pull snapshot** `cz-ndic_d2-common-pull` (one HTTP GET → all currently-valid situations). Move to the push feed `cz-ndic_d2-common` only when sub-minute freshness is needed.
- **Location decoding caveat:** point events often carry WGS84 directly; linear closures are frequently **Alert-C (TMC) / OpenLR** with no coordinates — store them flagged for decoding rather than dropping (the example does this via `needs_location_decoding`).
- **Scaling Europe:** GraphHopper `open-traffic-collection` (per-country DATEX II catalog); NAPSPAN (`napspan.com`) normalises ~24 NAPs to one GeoJSON schema (paid; worth it past ~3 countries).

### Surface / quality seed

- OSM `surface` + `smoothness` (weak prior; `smoothness` maps onto our excellent…very_poor tiers).
- HeiGIT global paved/unpaved (worldwide baseline, already matched to OSM geometry).
- StreetSurfaceVis (Zenodo `10.5281/zenodo.11449977`) — imagery model for a cold-start _quality_ layer; overwritten by real `surface_readings`.

### Licensing cheat-sheet

| Source                   | License              | Obligation                                         |
| ------------------------ | -------------------- | -------------------------------------------------- |
| OSM (POIs, surface)      | ODbL                 | Attribution + share-alike on derived DB            |
| Overture Places          | CDLA Permissive v2.0 | Permissive; **becomes ODbL if conflated with OSM** |
| Czech NAP / DATEX II     | Free, per-source     | Attribute NDIC / ŘSD                               |
| HeiGIT, StreetSurfaceVis | Open (CC)            | Attribution                                        |
| Mapillary imagery        | CC-BY-SA             | Attribution + share-alike                          |

---

## 8. Gaps & decisions to close

What stands between today's schema and "clear data on the map + in routes."

### 8.1 No external ingestion into `road_closures`

`road_closures` is operator-entered only. Nothing fills `source='official'`. **Action:** a scheduled NAP poller (pull → parse DATEX II → reconcile against the current snapshot → write `road_closures` with `source='official'`). Pattern reference: the `tarmoto-nap-events` example (poll → parse → reconcile → serve). Build it **inside `apps/backend`** against the existing table, not as a parallel service/table. → _Issue: NAP closure ingestion (#743)._

**Required schema migration — the current entity can't be reconciled as-is.** Today `RoadClosure` carries only the time window plus `source`, and `ClosuresService` derives "active" purely from `starts_at <= now AND (ends_at IS NULL OR ends_at >= now)`. There is **no way to detect a closure that vanished from a snapshot** (no external id, no last-seen stamp) and **no way to deactivate one while keeping it for audit** (no active flag) — an `official` closure with `ends_at = null` that disappears from the feed would otherwise stay visible forever. The feed-reconciliation columns must be added before the poller can work:

| Column                                           | Purpose                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `external_id` (+ unique `(source, external_id)`) | Stable upsert key per feed situation                                                        |
| `last_seen_at`                                   | Stamped to the batch time on every snapshot the row appears in                              |
| `is_active` (bool)                               | Set `false` when absent from the latest snapshot or `ends_at < now`; row retained for audit |
| `first_seen_at`                                  | When the situation first entered the feed                                                   |
| `validity_status` (nullable)                     | DATEX validity passthrough, optional                                                        |

Operator-entered rows keep working unchanged: they have no `external_id`, are never touched by the reconcile pass, and stay window-derived. Reads must treat a closure as live when `is_active` is not `false` **and** within its window, so both sources coexist.

### 8.2 Closures are not avoided during routing

`closures.checkRoute()` warns; it does not route around. **Action:** add buffered-closure → `exclude_polygons` and plumb it through `RoutingOptions` (the Valhalla path supports it natively). → _Issue: closure avoidance in route building._

### 8.3 POIs: external for MVP, stored for offline later

POIs are fetched **live from Overpass per request** today. That's the **MVP** decision: keep them external. It works for trip-planner stop suggestions (already outage-resilient), and defers a table + import job. The cost is that MVP has **no offline POIs and no pannable POI map layer** — both of which need stored data.

**Post-MVP (gated on the offline-packs feature):** store POIs in a `pois` PostGIS table refreshed on a periodic import, so they ship in offline packs (and gain a tileable layer + spatial joins as a side effect). Add a scheduled import that queries the §7 tag sets (Overpass, Overture gap-fill) and upserts `pois` by stable external id; switch `poi.service` read paths from per-request Overpass to the table; keep the existing `PoiProvider` as the _import_ source. Overwrite in place — no row TTL. → _Issue: POI import + offline storage (post-MVP)._

### 8.4 One TTL still undecided

- Raw `surface_readings` retention before prune: **proposed 90 days** — confirm against the ML re-aggregation window. (Hazard decay is **not** open — it's the per-type `EXPIRY_HOURS` + `confirm()` +24 h contract documented in §4; the weather dispatch cooldown is the 60-min window in §3.)

---

## 9. What to stand up first

1. **NAP closure ingestion** → `road_closures` (`source='official'`) — highest-value dynamic layer, free, home market (§8.1).
2. **Closure avoidance** in routing via `exclude_polygons` (§8.2) — makes the data actually change routes, not just warn.
3. **Surface-type seed** from OSM/HeiGIT into `road_segments.surface_type` where blank.
4. Defer the imagery-derived quality seed until the sensor pipeline is calibration-validated.

**Post-MVP:** POI import → `pois` table (§8.3), landing with offline packs.
