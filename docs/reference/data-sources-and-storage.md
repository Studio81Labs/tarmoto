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
| Road segments (geometry, name/number, length, ~100 m split) | `road_segments`                                                    | OpenStreetMap                               | PostGIS                                  | Weekly–monthly re-import           | none | UUIDs must stay stable across re-imports — but no stable OSM key exists yet (**gap, see §8.5**)                                                        |
| Curviness                                                   | `road_segments.curviness_score`                                    | Computed from OSM geometry                  | PostGIS                                  | Recompute on OSM refresh           | none | Radius-weighted; drives the "fun roads" map filter + route scoring                                                                                     |
| Surface **type** (asphalt/gravel/…) — seed                  | `road_segments.surface_type`                                       | OSM `surface` tag + HeiGIT pavedness (seed) | PostGIS                                  | OSM cycle / on dataset release     | none | Seed only; overwritten by sensor-derived value (§2)                                                                                                    |
| POIs (fuel, food, viewpoints, accommodation)                | **MVP: live via `overpass.provider`** · post-MVP: `pois` (PostGIS) | Overpass (OSM) + Overture gap-fill          | MVP: none (per request) · later: PostGIS | MVP: live · later: periodic import | none | MVP keeps POIs external — planner stop suggestions only. Stored import lands **with offline packs** to enable offline POIs + a POI map layer. See §8.3 |
| Fun zones (twisty-road clusters)                            | `fun_zones` + `fun_zone_road`                                      | Computed from `road_segments` curviness     | PostGIS                                  | Recompute on segment refresh       | none | See [fun-zone-clustering.md](fun-zone-clustering.md)                                                                                                   |

---

## 2. Crowdsourced & proprietary — the moat

Our own data. Nothing here is bought; this is the defensible asset. Quality is **denormalized onto `road_segments`**, not a separate table.

| Datum                                                                                        | Real table                                                                             | Source                           | Storage                                      | Refresh                                                                                                              | TTL                                                                                                               | Notes                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Raw per-window sensor readings (IRI, vibration, classification, device/calibration metadata) | `surface_readings`                                                                     | Rider devices                    | PostGIS (+ raw 50 Hz to object store/ingest) | Per ride upload                                                                                                      | **Per-user `location_retention`** (3 months … forever) via `LocationRetentionSweepProcessor`; **aggregates kept** | Anonymisable; carries no quality decision itself                                                         |
| Aggregated road quality + confidence                                                         | `road_segments.quality_score`, `.confidence`, `.reading_count`, `.last_filtered_count` | Pipeline over `surface_readings` | PostGIS                                      | **Trigger-driven on each new `surface_readings` insert** (`update_road_quality_for_segment`); **no scheduled sweep** | none — **recency-weighted** (old passes decay in _weight_, not deleted)                                           | Core asset; overwrites the surface seed. **Quiet segments don't decay** until a new reading lands (§8.6) |
| Hazard reports (pothole, gravel, oil, animal, police)                                        | `hazard_reports`                                                                       | Users (one-tap)                  | PostGIS (+ Redis push fan-out)               | Real-time                                                                                                            | **`expires_at` time-decay unless re-confirmed** (`is_active`, `confirmations`, `confirmed_at` already modelled)   | Indexed `(is_active, expires_at)`                                                                        |
| Road ratings + reviews                                                                       | `road_reviews` + `road_review_vote`                                                    | Users                            | PostGIS (+ object store for photos)          | On submit                                                                                                            | none                                                                                                              | User-owned; honour deletion                                                                              |

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

1. **Recompute, no row TTL** — segment enrichment (`quality_score`, `curviness_score`, `surface_type`). Rebuilt from sources; quality is **recency-weighted** (old passes lose weight, never deleted). Re-applied per segment **by a DB trigger on each new reading**, not on a timer — there is no nightly sweep, so a segment with no new uploads keeps its last aggregate (§8.6).
2. **Reconcile + expire** — `road_closures` from NAP. Poll ~3 min; a snapshot is the _full_ current truth, so absent ⇒ `active=false`; also expire when `ends_at < now`. History retained.
3. **Time-decay** — `hazard_reports`. Per-type base from `EXPIRY_HOURS` (pothole & roadworks 72 h; gravel, flooding, ice 48 h; oil*spill, animals, police, other 24 h). `HazardsService.confirm()` blocks only the **original reporter** (`hazard.user_id`); any other user can confirm, and **each confirm call adds +24 h** — there is **no per-confirmer dedup** (no `confirmed_by` column/predicate today), so repeated confirms from the same non-reporter keep extending expiry. A sweep deactivates when `expires_at < now`. *(The unbounded repeat-confirm extension is a known abuse gap, not an intended cap — track separately if TTL hardening is wanted.)\_
4. **Ephemeral** — weather _samples_ only (per-sweep memoised lookup, never persisted). **Not in this bucket, despite earlier drafts:** the weather **dispatch ledger** is a persisted Postgres cooldown record (§3), and **live group location is persisted too** — each `location:update` writes `group_ride_members.last_lat / last_lng / last_position_at / recent_path` in Postgres, which the severe-weather sweep reads within a 15-min window. Redis is only the Socket.IO fan-out adapter here, not the store — so live location carries real retention/privacy obligations and must not be treated as throwaway.

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
- **Location decoding caveat:** point events often carry WGS84 directly; linear closures are frequently **Alert-C (TMC) / OpenLR** with no coordinates — store them flagged for decoding rather than dropping (the example does this via `needs_location_decoding`). This requires the **nullable `geom` + `needs_location_decoding` + `raw_location_ref`** columns in §8.1 — `RoadClosure.geom` is non-null today, so without them these records would fail to insert or be dropped.
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

| Column                                           | Purpose                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_id` (+ unique `(source, external_id)`) | Stable upsert key per feed situation                                                                                                                                 |
| `last_seen_at`                                   | Stamped to the batch time on every snapshot the row appears in                                                                                                       |
| `is_active` (bool)                               | Set `false` when absent from the latest snapshot or `ends_at < now`; row retained for audit                                                                          |
| `first_seen_at`                                  | When the situation first entered the feed                                                                                                                            |
| `validity_status` (nullable)                     | DATEX validity passthrough, optional                                                                                                                                 |
| **`geom` made nullable**                         | Today `RoadClosure.geom` is a **non-null** `LineString`; Alert-C (TMC) / OpenLR closures arrive with no coordinates and must be storable with `geom = null` (see §7) |
| `needs_location_decoding` (bool)                 | `true` when only TMC/OpenLR refs were present and no geometry could be resolved; excluded from map + routing until decoded                                           |
| `raw_location_ref` (jsonb, nullable)             | Raw location reference captured for later decoding                                                                                                                   |

Operator-entered rows keep working unchanged: they have no `external_id`, are never touched by the reconcile pass, always carry geometry, and stay window-derived. Reads must treat a closure as live when `is_active` is not `false` **and** within its window, so both sources coexist.

**Null geometry affects _every_ closure read path, not just map/routing.** `ClosuresService.toDto()` reads `r.geom.coordinates` and `RoadClosureDto.geometry` is a **required** field, so `GET /closures/:id` and `GET /closures?include_past=true` would **500** the moment an undecoded (`geom IS NULL`) row is fetched. The migration contract must therefore do one of: **(a)** exclude `needs_location_decoding = true` / `geom IS NULL` rows from **all** public closure reads (list, detail, geojson, routing — add the filter in `ClosuresService`, not just the map/router callers), or **(b)** make `RoadClosureDto.geometry` nullable and have `toDto()` tolerate a null geom. (a) is simpler and is the recommended default — undecoded rows stay invisible until they gain coordinates.

### 8.2 Closures are not avoided during routing

`closures.checkRoute()` warns; it does not route around. **Action:** add buffered-closure → `exclude_polygons` and plumb it through `RoutingOptions` (the Valhalla path supports it natively). → _Issue: closure avoidance in route building._

### 8.3 POIs: external for MVP, stored for offline later

POIs are fetched **live from Overpass per request** today. That's the **MVP** decision: keep them external. It works for trip-planner stop suggestions (already outage-resilient), and defers a table + import job. The cost is that MVP has **no offline POIs and no pannable POI map layer** — both of which need stored data.

**Post-MVP (gated on the offline-packs feature):** store POIs in a `pois` PostGIS table refreshed on a periodic import, so they ship in offline packs (and gain a tileable layer + spatial joins as a side effect). Add a scheduled import that queries the §7 tag sets and upserts `pois` by stable external id; switch `poi.service` read paths from per-request Overpass to the table; keep the existing `PoiProvider` as the _import_ source. Overwrite in place — no row TTL. → _Issue: POI import + offline storage (post-MVP)._

**Licensing — do not conflate OSM and Overture into one derived table.** Per the §7 ODbL boundary, merging Overpass (OSM/ODbL) and Overture (CDLA Permissive) into a single combined DB can force the whole `pois` table under ODbL. Keep them as **separate source-tagged layers** — either distinct tables (`pois_osm` / `pois_overture`) or a single table where Overture rows are an independent, separately-licensable layer joined at read time, never row-level merged into OSM records. The import contract must preserve that separation; Overture is gap-fill alongside OSM, not blended into it.

### 8.4 Retention: one open gap, plus governed contracts

- **Open gap — group location has no retention/clear-on-end.** §4 notes live location is persisted to `group_ride_members` (`last_lat / last_lng / last_position_at / recent_path`). But `LocationRetentionSweepProcessor` only touches `surface_readings`, `rides.route_geom`, and `ride_tag_events` — it **never clears `group_ride_members`** — and ending a group ride just sets `ended_at`, leaving the last-position and `recent_path` breadcrumb buffer in place **indefinitely**. That's a privacy hole: an ended ride keeps a rider's last location forever. **Action:** clear `last_lat/last_lng/last_position_at/recent_path` on ride end, and/or fold `group_ride_members` into the retention sweep. → _Issue: group-location retention._
- **Governed — raw `surface_readings` retention is per-user `location_retention`**, not a flat value. `LocationRetentionSweepProcessor` deletes a rider's raw readings (and `ride_tag_events`) per their saved bucket — `3months` / `6months` / `1year` (default) / `2years` / `forever` — while **keeping the recency-weighted aggregates**. A prune job must **not** impose a global 90-day cap. **Constraint:** the ML re-aggregation window must fit inside the **shortest** bucket (3 months) so a `3months` rider's data is aggregated before deletion.
- **Governed —** hazard decay is the per-type `EXPIRY_HOURS` + `confirm()` +24 h contract (§4); the weather dispatch cooldown is the 60-min window (§3).

### 8.6 Quality aggregation is trigger-only — no decay on quiet segments

`update_road_quality_for_segment` runs **only as a DB trigger on `surface_readings` insert** (it lives in the schema/migrations; there is no scheduled re-aggregation job). So recency-weighting is re-applied **only when a new reading lands** on a segment. A segment that stops getting uploads keeps its last `quality_score` indefinitely — the weights never age on their own. Anyone relying on "freshness" (operators, ML re-training) must not assume a nightly decay that doesn't exist. **If time-based decay on quiet segments is wanted, it needs a scheduled re-aggregation job** — otherwise document the trigger-only semantics as the contract. → _Optional issue: scheduled quality re-aggregation._

### 8.5 No stable segment identity for OSM re-imports

§1 says `road_segments` UUIDs must stay stable across weekly/monthly OSM re-imports — but the current `RoadSegment` has **only a generated UUID** plus geometry/name/number/length. There is **no OSM way id, segment ordinal, or other deterministic key** to upsert against. A re-importer would either mint fresh UUIDs (orphaning every `surface_readings`, `road_reviews`, `hazard_reports`, and `fun_zone_road` row that references the old id) or fall back to brittle geometry matching. **Action before the first re-import:** add a stable identity to `road_segments` — e.g. `osm_way_id` + a `segment_index` ordinal (unique together) — and key the re-import upsert on it so existing FKs survive. Until then, treat "stable UUIDs across re-imports" as aspirational. → _Issue: stable segment identity._

---

## 9. What to stand up first

1. **NAP closure ingestion** → `road_closures` (`source='official'`) — highest-value dynamic layer, free, home market (§8.1).
2. **Closure avoidance** in routing via `exclude_polygons` (§8.2) — makes the data actually change routes, not just warn.
3. **Surface-type seed** from OSM/HeiGIT into `road_segments.surface_type` where blank.
4. Defer the imagery-derived quality seed until the sensor pipeline is calibration-validated.

**Post-MVP:** POI import → `pois` table (§8.3), landing with offline packs.
