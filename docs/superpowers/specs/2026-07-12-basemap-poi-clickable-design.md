# Clickable basemap (OpenStreetMap) POIs

Status: approved design, phased delivery.

## Goal

The basemap (OpenFreeMap "liberty") renders its own OpenStreetMap POI icons —
parking, parks, info points, picnic areas, waste bins — from the OpenMapTiles
`poi` source-layer (`poi_r1`, `poi_r7`, `poi_r20`, `poi_transit`). Today they
are inert decoration. Make them clickable so a rider can see what a place is and
act on it, reusing the shared `MapPointPopover` — without confusing them with
our curated `pois`.

## What the basemap gives us

Each `poi` feature carries only `name`, `class`, `subclass`, `rank` (+ localized
names). No photos, hours, descriptions, or a Maps URL. So the popover is a
lighter body than a curated POI: **name + a friendly category label + a "View on
Google Maps" link**, credited to OpenStreetMap.

## Decisions (confirmed)

1. **Interaction:** info card + Google Maps link everywhere; on the editable
   planner, also **add as via / set start / finish** (reusing the curated-POI
   placement path). No "add as typed stop" — a basemap place has no
   `PoiCategory`.
2. **Surfaces:** all three maps (explorer, planner, preview) — they share the
   basemap.
3. **Only named POIs are interactive.** Unnamed OSM points are skipped, which
   cuts noise and avoids empty cards.
4. **Lowest priority.** Our hazards / conditions / curated pins always win an
   overlap; a basemap POI beats only the road-segment select beneath it.

## Architecture

- **`lib/basemap-poi.ts`**
  - `getBasemapPoiLayerIds(map)` — enumerate style layers with
    `source-layer === "poi"` and `type === "symbol"` (dynamic; survives a style
    / env change).
  - `readBasemapPlace(feature)` → `{ name, category, lng, lat, mapsUrl } | null`
    (null when unnamed / non-point).
  - `basemapPlaceCategoryLabel(class, subclass)` — curated labels for common OSM
    classes, title-cased fallback.
  - `basemapPlaceMapsUrl(name, lat, lng)` — Google Maps search URL.
  - `topBasemapPlaceAt(map, point, layerIds)` — the topmost named place under a
    click, or null.
- **`MapPointPopover`** gains `{ kind: "place"; place: BasemapPlace }`. Shared
  `PlacementActions` sub-component (extracted from `PoiBody`) renders the
  add-as-via/start/finish block for both POIs and places. A `PlaceBody` shows a
  map-pin badge, the category, an OSM credit, the placement actions (editable
  planner), and the Google Maps link.
- **Explorer (`QualityMap`)** — no new router route; the router's `onMiss`
  checks `topBasemapPlaceAt` first (open the place popover) before dismissing /
  selecting a road, so our markers still win and unnamed POIs fall through.
- **Planner / preview (`TripPlannerMap`)** — a `placeMenu` with a click handler
  guarded behind all our markers + the route line; editable planner wires the
  placement actions, preview is info-only.

## Phasing

- **PR A** — `basemap-poi.ts` + popover `place` kind + explorer (info-only; the
  explorer has no route to add to).
- **PR B** — planner + preview: place popover + add-as-stop on the editable
  planner.

## Risks / notes

- The planner isn't on the shared click router yet, so PR B uses a broad
  priority guard (bail if any of our layers is under the cursor) as an interim —
  it folds into the eventual planner router adoption.
- OSM category labels are best-effort; the title-cased subclass is the fallback.
- Surfacing OSM POI data warrants the "© OpenStreetMap contributors" credit in
  the card, alongside the basemap's existing global attribution.
