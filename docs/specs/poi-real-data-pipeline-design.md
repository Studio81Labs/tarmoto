# POI Real-Data Pipeline — Design

> Status: **Proposal / for review** · Date: 2026-07-06 · Scope: `backend`, `companion`, `mobile`, `shared`, `openapi`, `docs`
>
> Turns the current demo/mock POIs into real, refreshed, decision-grade POIs served from our own store, with commercial enrichment (ratings/photos) added in a licence-safe way. Elaborates EPIC 2 / US-10, US-11, US-36 in [tarmoto-product-spec.md](./tarmoto-product-spec.md) and updates [../reference/data-sources-and-storage.md](../reference/data-sources-and-storage.md) §1/§8.3.

---

## 1. Why this doc exists

"We only have demo POIs" is only half true. The **visible** demo POIs are frontend mock fixtures, but a real (dormant) OSM pipeline and real live endpoints already exist. This design closes the gap between the three POI systems that exist today and turns them into one coherent, refreshed, decision-grade dataset.

### 1.1 What exists today (grounded)

| System                                                   | State                                                                                                 | Location                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion **mock** POIs (~38 hardcoded CZ POIs)          | Backs the **visible** planner STOPS tab + map category bar                                            | `apps/companion/src/lib/planner/mocks/pois.ts`; resolvers `getPoisByCategories`, `getRouteStops` in `lib/planner/api.ts`                                       |
| Live **Overpass** `/poi/*` endpoints (real OSM)          | **Live in prod**, used by mobile; corridor search is production-quality                               | `apps/backend/src/modules/poi/` (`poi.controller.ts`, `poi.service.ts`, `providers/overpass.provider.ts`)                                                      |
| `pois` **PostGIS store** + weekly BullMQ importer (#745) | **Built but dormant** (`TARMOTO_POI_IMPORT_ENABLED=false`); **table is write-only, nothing reads it** | `entities/poi.entity.ts`, `migrations/1787000000000-AddPois.ts`, `modules/poi/poi-import.service.ts`, `modules/jobs/*` (queue `poi.import`, `WEEKLY_SUN_0300`) |

Key consequences:

- **A refresh cron already exists** (weekly Sun 03:00 UTC BullMQ repeatable). We do not build one; we enable + scale it.
- **Provenance is already stored**: `source` (`'osm'`), `external_id` (`osm:<type>:<id>`), `last_imported_at`.
- **The stored schema is thin**: only `name, website, phone, kind, geom`. No hours, address, ratings, photos, cuisine, or raw tags.
- **Fields that are captured are not surfaced**: mobile uses `website`/`phone` only as an invisible tap-through target; the companion fetches `website`/`phone`/`hint`/`stars` from the live endpoint and **drops them in its converters** (`lib/planner/api.ts:133-154`).
- **The store has no read path**: all `/poi/*` reads hit Overpass live per request.

### 1.2 Decisions taken (steering answers)

1. **Read path → store-backed.** Enable the importer and build a PostGIS read path over `pois`; keep live Overpass as a fallback for un-imported areas / freshness. (Required for a pannable POI map layer and the companion category bar — you cannot hit Overpass on every map pan.)
2. **Enrichment → OSM + commercial now.** First pass includes a commercial provider (ratings/reviews/photos, rich "restaurant page" links) **in addition to** OSM fields — implemented in the only licence-compliant way (see §6): OSM data is persisted; commercial data is fetched on demand and not persisted beyond provider ToS.
3. **Coverage → Central Europe + Alps + Balkans.** CZ, SK, PL, DE, AT, IT + the Balkans (SI, HR, BA, RS, ME, MK, AL, XK, BG) and SE Europe (RO, GR). Weekly refresh. _(Assumption to confirm: include CH, FR, LI for Alpine riding — natural gaps between AT/IT; flagged in §11.)_

---

## 2. Target architecture

Three ingestion tiers feeding one store, with two licence-separated layers.

```
                 ┌────────────────────────── INGESTION ──────────────────────────┐
 Bulk (scale):   Geofabrik .osm.pbf per country ──osmium tag-filter──▶ PoiImportService ─┐
 Live (fresh):   Overpass API (bbox / around) ─────────────────────────────────────────┤──▶  pois (PostGIS, ODbL)
                                                                                         │     source, external_id, kind, geom,
                                                                                         │     name, website, phone, opening_hours,
                                                                                         │     address_*, cuisine, brand, stars,
                                                                                         │     tags(jsonb), place_ref*, timestamps
                 └────────────────────────────────────────────────────────────────┘          │
                                                                                              │  (read path — NEW)
 Commercial      EnrichmentProvider (Foursquare / Google Places)                              ▼
 (on-demand):    fetched at POI-detail view, short-TTL cache, NOT persisted ───────▶  PoiService (PostGIS ST_DWithin / bbox / corridor)
                 (only the match id place_ref is stored)                                      │
                                                                                              ▼
                                                                      /poi/in-bbox · /poi/nearby · /poi/along-route · /poi/:id
                                                                                              │
                                                          ┌───────────────────────────────────┼───────────────────────────────┐
                                                          ▼                                    ▼                               ▼
                                                    Companion planner                    Mobile trip screens          Map POI tile/overlay layer
                                              (category bar + STOPS → real)        (surface website/phone/hours)     (pannable, store-backed)
```

### 2.1 Two licence-separated layers (critical)

`docs/reference/data-sources-and-storage.md` §1/§8.3 already mandates: **never row-merge OSM (ODbL) and non-ODbL sources into one derived table** — merging can force the whole `pois` table under ODbL. This design keeps that boundary and extends it to the commercial layer:

- **Persisted layer = OSM only (ODbL).** Everything written to `pois` comes from OSM. Storable, share-alike, publishable in offline packs.
- **Commercial layer = ephemeral.** Foursquare/Google data (ratings, reviews, photos, price level) is **fetched on demand** at detail-view time, cached short-TTL, and **never written into `pois`**. Only the provider's stable **match id** (`fsq_id` / `google_place_id`) is persisted, plus the timestamp of the match. This satisfies both the ODbL-separation rule _and_ Google Places ToS (see §6).

---

## 3. Data model changes

### 3.1 `pois` schema delta (persisted OSM layer)

New nullable columns on `pois` (all sourced from OSM tags the importer currently drops). Migration authored via `migration:create` (raw SQL) per `docs/process/typeorm-migrations.md` because of the GIN index:

| Column                  | Type           | Source (OSM tag)                     | Purpose                                                                                                    |
| ----------------------- | -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `opening_hours`         | `varchar(512)` | `opening_hours`                      | "Is it open?" decision support                                                                             |
| `address_street`        | `varchar(255)` | `addr:street` (+ `addr:housenumber`) | Address display                                                                                            |
| `address_city`          | `varchar(128)` | `addr:city`                          | Address display                                                                                            |
| `address_postcode`      | `varchar(32)`  | `addr:postcode`                      | Address display                                                                                            |
| `address_country`       | `varchar(2)`   | `addr:country` / import region       | Address + country filter                                                                                   |
| `cuisine`               | `varchar(128)` | `cuisine`                            | Restaurant/cafe decision support (persist today's transient `hint`)                                        |
| `brand`                 | `varchar(128)` | `brand` / `operator`                 | Fuel brand, chain identity                                                                                 |
| `stars`                 | `smallint`     | `stars`                              | Accommodation class (persist today's transient value)                                                      |
| `tags`                  | `jsonb`        | bounded raw tag bag                  | Future-proofing: wheelchair, fee, capacity, `brand:wikidata`, etc. Avoids re-migrating for every new field |
| `google_place_id`       | `varchar(128)` | commercial match                     | Allowed-to-persist id → rich detail link + on-demand hydration key                                         |
| `fsq_id`                | `varchar(64)`  | commercial match                     | Same, Foursquare                                                                                           |
| `enrichment_matched_at` | `timestamptz`  | match run                            | Match provenance / re-match cadence                                                                        |

Indexes: `GIN (tags jsonb_path_ops)` for tag filtering; existing `(source, external_id)` unique, `GiST (geom)`, and `(kind)` stay. Add `(address_country, kind)` for country/category browse.

`down()` drops the added columns/indexes. `source`/`external_id`/`last_imported_at` are unchanged — provenance already correct.

### 3.2 Detail links (answers "link to open a POI detail / restaurant page")

A POI exposes up to three links, normalized in the DTO — `maps_url` is always present; the other two are conditional:

- **`osm_url`** — derivable from `external_id` → `https://www.openstreetmap.org/<node|way|relation>/<id>` (only for `osm:`-sourced rows). Doubles as the ODbL **source/attribution** link.
- **`website`** — the venue's own page (OSM `website`/`contact:website`), when tagged.
- **`maps_url`** — a **non-null** Google Maps link, delivered in two tiers with a stable type:
  - **Today (free — no key, no API call, no enrichment):** a search deep link built from the POI's name + coordinates — `https://www.google.com/maps/search/?api=1&query=<name> <lat>,<lng>` (URL-encoded; coordinates only when the POI is unnamed). This already gives riders the Google "restaurant page" (photos, reviews, live hours) and makes even nameless/contactless rows navigable — which is why the rankers keep them rather than dropping "no name + no contact" rows.
  - **After Phase 3 enrichment:** once a `google_place_id` match exists, `maps_url` **upgrades in place** to the exact-venue link `https://www.google.com/maps/place/?q=place_id:<id>` (or the FSQ venue URL).

### 3.3 Shared contract alignment

Today POI types are **not** in `@tarmoto/shared` — they are duplicated (backend DTOs, `apps/mobile/src/types/index.ts`, companion `lib/planner/types.ts` + `lib/api.ts`). CLAUDE.md says domain enums belong in `@tarmoto/shared`. As targeted cleanup for the code we're touching:

- Move `POI_KINDS`, `ACCOMMODATION_KINDS`, and the companion's `PoiCategory` union into `@tarmoto/shared` as the single source of truth; backend DTOs and both clients import them.
- Reconcile the **two taxonomies**: the backend's 4 live kinds + accommodations vs. the companion's 8 curated categories (`fuel, food, cafe, viewpoint, campground, biker_hotel, mountain_pass, twisty_highlight`). `mountain_pass` and `twisty_highlight` are **Tarmoto-derived, not OSM** — they stay separate layers (passes module + curviness layer), mapped in the client, never written to `pois`.

---

## 4. Read path (store-backed)

New/changed backend queries over `pois` (PostGIS), mirroring the proven `ST_DWithin`-over-LINESTRING pattern already used by the passes module (`apps/backend/src/modules/passes/passes.service.ts:84-107`):

| Endpoint                                    | Query                                                               | Consumer                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /poi/in-bbox` (**new**)                | `ST_MakeEnvelope` + `geom &&` + `kind IN (...)`, capped/paginated   | Pannable map layer + companion **category bar** (`getPoisByCategories`) |
| `GET /poi/nearby` (switch to store)         | `ST_DWithin(geom, point, radius)` order by distance                 | Mobile "nearby stops"                                                   |
| `POST /poi/along-route` (switch to store)   | `ST_DWithin(geom, ST_MakeLine(route), buffer)` + project onto route | Companion **STOPS tab** (`getRouteStops`), mobile fuel-range warning    |
| `GET /poi/:id` (**new**)                    | fetch one + **on-demand commercial hydration** (§6)                 | POI detail sheet (both clients)                                         |
| `GET /poi/accommodations` (switch to store) | `ST_DWithin` + `stars >=` filter                                    | Overnight-stop suggestions                                              |

**Fallback contract:** store-first, live-Overpass fallback when a region has no imported rows (so we never regress areas outside the current import bbox). Preserve the existing resilience posture — provider/DB failure returns an **empty list, never a 500**, and **rider coordinates stay out of logs** (`poi.service.ts:87-102`).

**Companion wiring:** repoint the two mock resolvers (`getPoisByCategories` → `/poi/in-bbox`; `getRouteStops` → `/poi/along-route`) and **stop discarding fields** in `alongRoutePoiToPlannerPoi`/`accommodationToPlannerPoi` (`lib/planner/api.ts:133-154`). Delete `lib/planner/mocks/pois.ts` once wired.

---

## 5. Ingestion & refresh

### 5.1 Bulk import at continent scale — Geofabrik, not Overpass

The current importer calls Overpass with a single bbox. That works for one small CZ box; it **will not** survive full-country POI pulls for 15+ countries (Overpass public API time/memory limits). The repo already solved this for roads: **Geofabrik `.osm.pbf` → `osmium` extract → local parse** (`apps/backend/src/modules/roads/osm-import/osm-import.config.ts`, `TARMOTO_OSM_IMPORT_FILE/BBOX`). We mirror it for POIs:

1. Operator downloads Geofabrik per-country `.osm.pbf`.
2. `osmium tags-filter` to our POI tag set (amenity=fuel/restaurant/cafe/fast_food/ice_cream, tourism=hotel|guest_house|…|viewpoint, highway=rest_area|services) → small per-country extract.
3. `PoiImportService` parses the extract and upserts into `pois` by `(source, external_id)` — idempotent, outage-safe (fetch/parse failure aborts before any write), chunked.
4. **Stale-by-absence tombstoning** bounded by the import bbox, exactly as the roads importer does (`osm-import.config.ts` bbox contract) — so closed venues eventually drop out without deleting rows outside the extract.

Keep `OverpassPoiProvider` for **live fallback** and small ad-hoc refreshes; abstract both behind the existing provider seam (`poi-provider.interface.ts`).

### 5.2 Schedule & coverage

The BullMQ weekly repeatable already exists (`poi.import`, `WEEKLY_SUN_0300`). Change:

- **Stagger per country** (fan out the one job into per-region jobs, or loop countries within the job with checkpointing) so a 15-country run doesn't block one queue slot for hours.
- **Coverage list (config-driven):** CZ, SK, PL, DE, AT, IT, SI, HR, BA, RS, ME, MK, AL, XK, BG, RO, GR. `TARMOTO_POI_IMPORT_REGIONS` replaces the single `TARMOTO_POI_IMPORT_BBOX`.
- **Cadence:** weekly is ample for POI churn (TTL: none, overwrite-in-place — consistent with the roads/OSM cycle).
- **Volume estimate:** low-millions of filtered rows region-wide; GiST + GIN indexed PostGIS handles this comfortably. Validate exact counts + per-country runtime in Phase 2.

---

## 6. Commercial enrichment (ratings / reviews / photos) — licence-safe

The steering choice is "commercial now." The **only compliant** way to do this is on-demand, not stored:

- **Google Places ToS:** you may persist the **Place ID indefinitely**, but most content (rating, reviews, photos, hours) **must not be cached beyond ~30 days**, reviews must be shown fresh with Google attribution, and photos served via photo references (not stored bytes). ⇒ We **cannot** put Google ratings/photos in `pois`.
- **Foursquare Places:** more cache-friendly, generous free tier, `fsq_id` persistable. Good **primary** commercial provider; Google as the rich fallback / where FSQ coverage is thin.

**Design:**

1. **Match** OSM POIs to a commercial place (name-normalized + geo-proximity within ~50 m + category agreement), storing only `fsq_id` / `google_place_id` + `enrichment_matched_at`. Run as a low-priority pass after import (or lazily on first detail view).
2. **Hydrate on demand** at `GET /poi/:id` via `EnrichmentProvider` (new interface, same pattern as routing/geocode provider abstractions): returns `rating`, `review_count`, `price_level`, `photos[]`, live `hours`, and the **upgraded `maps_url`** (exact-venue place-id link, replacing the free name+coordinates search link). Response cached short-TTL (Redis, ≤ provider limit) — **never written to `pois`**.
3. **Cost controls:** hydrate only on explicit detail view (not list/map render), Redis cache, per-day budget guard + rate limit, feature-flagged (`TARMOTO_POI_ENRICHMENT_ENABLED`, provider + key envs). Directional cost: on-demand + cache keeps this to detail-view volume, not POI-count volume. _(Confirm current Google/FSQ pricing at build time — pricing SKUs change.)_
4. **Attribution/branding:** "Powered by Google" / FSQ attribution on any enriched detail surface, per each provider's brand requirements.

### 6.1 v1 delivery scoping — FSQ-only, navigation-start batch, budget-locked

The four points above are the target model. The **first cut** deliberately narrows it to stay inside a paid provider's free tier and de-risk recurring cost (scoping agreed 2026-07-11):

- **FSQ only.** Foursquare Places is the sole v1 provider — more cache-friendly terms and a monthly free-request allotment. Google Places is deferred: its list / pre-fetch terms are stricter, so it is added later only if its ToS for this pattern checks out.
- **Trigger = navigation start (batch), not continuous render.** When the **mobile** app starts navigation the route is locked; the backend enriches the POIs _along that locked route_ in one bounded batch and holds it for the nav session (short-TTL, keyed by route hash + POI ids). A re-route is a new route ⇒ a new (budgeted) batch. This is **not** the forbidden "enrich on every map pan / list scroll": it is a single, explicit, high-intent user action over a bounded POI set. The §6 point-2 detail-view trigger stays available for individual POI opens (same provider + budget lock).
- **Hard budget lock.** An atomic Redis counter tracks **provider requests, not batches** — a batch issues ~1–2 calls per enriched POI (see below), so a single `INCR` per batch would undercount N× and sail past the free tier. Each batch **reserves its expected request count up front** (one atomic `INCRBY expectedCalls`, reserve-before-call so concurrent nav-starts race safely); if the reservation would cross the monthly ceiling the batch enriches only the subset the remaining budget affords (down to zero → **OSM-only**) and rolls the unused reservation back after reconciling to the calls actually made. The per-batch reservation is bounded by the top-N-POIs cap. Enforced on the **backend**, independent of client, so nothing bypasses it — no error, no blank when it trips.
- **Mobile-nav gated (v1).** Only active navigators trigger enrichment; companion route-planning does not enrich in v1 (a cost decision, revisitable). The _trigger_ is client-gated (a mobile-nav flag / dedicated enriched endpoint); the _budget_ is server-enforced.
- **Matching = the call-volume lever.** Chosen at build time by call cost: (a) _match-then-details_ — match each OSM POI to an `fsq_id` (§6 point 1) then fetch details, ~1–2 calls/POI; or (b) _corridor nearby-search then merge_ FSQ's own places against OSM (fewer calls, reuses the #932 cross-source dedup). Cap enrichment to **top-N** POIs per route so a long route cannot burst dozens of calls.
- **Latency.** Return OSM immediately and enrich **progressively** (stream / patch in) so navigation start never blocks on the batch.
- **Attribution follows the data (compliance blocker).** The nav-start batch means enriched FSQ fields can render in the **navigation list/map**, not only the detail view — so the required Foursquare branding must appear on **every** surface that shows enriched fields, not just enriched detail surfaces (widening §6 point 4 / §8, which scoped it to detail). Alternatively, constrain the batch to **pre-warm the cache only**, keeping enriched fields hidden until a properly-attributed detail view renders them. Either way, no enriched field is ever shown without its provider branding.
- **Degradation (as §6):** enrichment off / no match / provider error / **budget exhausted** → OSM fields render, no 500, no blank.

**Still gated on a human decision** (AGENTS.md, §851): FSQ confirmed as provider, current FSQ pricing + free quota verified, API key provisioned, monthly cap set. No code until those land.

---

## 7. Rider decision-support — before vs. after

Directly answers "info that helps a rider decide if this is the right POI."

| Field                                      | Today (stored / surfaced)         | After                                             |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------- |
| Name, category, distance (off/along route) | ✅ / ✅                           | ✅ / ✅                                           |
| Source + external id (provenance)          | ✅ / partial                      | ✅ / ✅ (`osm_url` shown as source link)          |
| Website                                    | ✅ stored / ❌ hidden tap-through | ✅ / ✅ **shown as labelled link**                |
| Phone                                      | ✅ stored / ❌ hidden             | ✅ / ✅ **shown, `tel:` action**                  |
| Opening hours                              | ❌                                | ✅ stored (OSM) + ✅ live (commercial)            |
| Address                                    | ❌                                | ✅ stored + shown                                 |
| Cuisine / fuel brand                       | transient `hint`                  | ✅ persisted + shown                              |
| Accommodation stars                        | transient                         | ✅ persisted + shown                              |
| **Rating / reviews**                       | ❌                                | ✅ on-demand (commercial), shown with attribution |
| **Photos**                                 | ❌                                | ✅ on-demand (commercial)                         |
| Price level                                | ❌                                | ✅ on-demand (commercial)                         |
| Rich detail link ("restaurant page")       | ❌                                | ✅ `maps_url` + `website` + `osm_url`             |

---

## 8. Licensing & attribution compliance (must-do to go live)

Currently a documented obligation with **no UI implementation** — this is the clearest go-live blocker.

- **OSM / ODbL:** "© OpenStreetMap contributors" on every surface that shows POIs (map attribution control + list/detail footers). Our derived `pois` DB is ODbL; any offline pack inherits it.
- **Separation:** commercial data never merged into `pois` (guaranteed by §2.1/§6).
- **Commercial:** provider-required attribution/branding on **every surface that displays enriched fields** — the detail view **and** the v1 nav-start list/map (§6.1) — never detail-only.
- Update `docs/reference/data-sources-and-storage.md` §1/§8.3 (read-path switch, commercial layer, expanded coverage, attribution status) and add an **ADR** (`docs/decisions/0007-poi-data-and-enrichment.md`) capturing the store-backed read + commercial-provider + licence-separation decision.

---

## 9. Phased delivery plan

Each phase is independently shippable and issue-sized (AGENTS.md: one deliverable per PR/issue).

- **Phase 0 — Enable + capture (backend).** Migration for the §3.1 columns; extend `overpass.provider` + `PoiImportService` to read/store the new OSM tags; turn the importer on for the **current CZ bbox** behind the flag; verify the write path end-to-end. No client changes. _Scope: `backend`, `docs`._
- **Phase 1 — Read path + surface fields.** PostGIS read queries (`/poi/in-bbox`, switch nearby/along-route/accommodations to store-first + live fallback, `/poi/:id`). Wire companion's two mock resolvers to real endpoints; stop dropping fields; delete mock fixtures. Mobile + companion: surface website/phone/hours/address + `osm_url`. _Scope: `backend`, `companion`, `mobile`, `openapi`._
- **Phase 2 — Continent-scale ingestion.** Geofabrik + `osmium` bulk import (reuse roads pattern), `TARMOTO_POI_IMPORT_REGIONS`, staggered per-country weekly jobs, bbox-bounded stale tombstoning, index/volume tuning. _Scope: `backend`, `infra`, `docs`._
- **Phase 3 — Commercial enrichment.** `EnrichmentProvider` (FSQ primary / Google), OSM↔commercial matcher (store ids only), `GET /poi/:id` on-demand hydration + Redis cache + budget/rate guards, POI detail sheet (ratings/photos/reviews/price) with attribution. _Scope: `backend`, `companion`, `mobile`._ **v1 lands per §6.1** (FSQ-only, mobile navigation-start batch, atomic budget lock, degrade-to-OSM); Google + companion enrichment are fast-follows.
- **Phase 4 — Compliance + shared contract.** ODbL + commercial attribution wired into all POI surfaces; move POI enums/types into `@tarmoto/shared`; ADR + data-sources doc update. _Scope: `shared`, `companion`, `mobile`, `backend`, `docs`._

---

## 10. Risks & open questions

- **Overpass at scale** — mitigated by moving bulk import to Geofabrik/osmium; Overpass stays fallback-only.
- **Commercial cost drift** — the v1 volume driver is **navigation-start batches** (each enriches up to top-N POIs per route), not just detail-view opens, so cost is sized on request count, not detail-open count. Bounded by the §6.1 request-count budget lock (reserve-before-call, hard monthly ceiling → degrade-to-OSM), the top-N-per-route cap, and short-TTL cache, with progressive enrichment for latency. Still needs a real pricing check and a monthly cap at build time.
- **OSM↔commercial match quality** — name/geo matching is fuzzy; mis-matches show the wrong rating. Mitigate with a tight distance + category threshold and a "unverified match" state; prefer OSM `brand:wikidata` where present.
- **`twisty_highlight` category** — Tarmoto-derived (curviness layer), not OSM; not covered by this pipeline. Keep as a follow-up layer; the companion keeps its client-side mapping.
- **Storage/runtime** for 15+ countries — validate in Phase 2 before enabling all regions in prod.

## 11. Assumptions

- Include **CH, FR, LI** in coverage for Alpine riding (natural gaps between AT/IT) — assumed **in**, easy to drop if not wanted.
- Weekly refresh cadence is acceptable (matches roads/OSM cycle).
- **Foursquare** as primary commercial provider (caching terms + free tier); **Google Places** as rich fallback. Provider is abstracted, so this is reversible.
- Offline packs (the originally-intended `pois` reader) remain a **later** concern; this design ships store-backed _online_ reads first.
