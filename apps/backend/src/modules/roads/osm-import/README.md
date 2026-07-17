# OSM → `road_segments` import (#781, folder model — Sub-project B)

Populates the base road network from OpenStreetMap and assigns the stable
`(osm_way_id, segment_index)` identity (#751) so re-imports preserve UUIDs and
all dependent FKs (`surface_readings`, `road_reviews`, `hazard_reports`,
`fun_zone_roads`).

## Pipeline

```
apps/ingest refresh-road-extracts.js → <extractDir>/<code>.osm (one per region)
                                                    │
                                                    ▼
         OsmImportService.importAll() loops the configured regions
                                                    │  per region:
                                                    ▼
  parseOsmXml → assembleWays → buildSegmentRows → importRegion → filterToRegion(polygon) → reconcile(polygon)
```

- **Producer** — `apps/ingest` (a separate deployable) downloads each region's
  Geofabrik PBF, `osmium tags-filter`s it to the drivable-highway set
  (`ROAD_TAGS_FILTER_EXPRESSIONS` — the same `DRIVABLE_HIGHWAYS` list this
  module's `osm-tags.ts` gates on, so the two can't drift), `osmium extract -b`s
  it to the region's bbox, and atomically writes `<extractDir>/<code>.osm`. See
  `refresh-road-extracts.ts` and
  [the runbook](../../../../../../docs/process/runbook.md#road-quality-extract-refresh-sub-project-b)
  § "Road-quality extract refresh (Sub-project B)".
- **Importer** (this module, in the backend) — `osm-xml-source.ts` streams an
  `.osm` XML file into flat OSM primitives; `osm-assemble.ts` resolves node
  refs into `OsmWay` objects with geometry; `segmentation.ts` / `osm-tags.ts` /
  `segment-rows.ts` split each way into ~100 m segments and derive per-segment
  columns; `osm-import.service.ts`'s `OsmImportService` bulk-upserts
  `ON CONFLICT (osm_way_id, segment_index)`, preserving crowdsourced
  quality/confidence/reading_count and (via the durable `surface_from_reading`
  flag, #796) rider-classified surfaces.

## The folder model (Sub-project B)

This importer used to read **one** hand-prepared `.osm` file clipped to **one**
hand-configured bbox (the now-retired single-file `TARMOTO_OSM_ROAD_IMPORT_*`
env pair — a `FILE` path + a `BBOX` rectangle). It now reads a **folder** of
per-region extracts, mirroring the POI importer's model:

- **`extractDir`** (`TARMOTO_OSM_ROAD_IMPORT_DIR`) — a directory of `<code>.osm`
  files, one per region, named by lower-case ISO 3166-1 alpha-2 code (e.g.
  `cz.osm`). The SAME shared volume the `apps/ingest` producer writes and this
  importer reads — both apps must point at the same path. `null`/unset skips
  the whole job (nothing to read).
- **`regions`** (`TARMOTO_OSM_ROAD_IMPORT_REGIONS`, default all
  `DEFAULT_REGIONS`) — the coverage list, the SAME 17-country list POI/FSQ use
  (`packages/ingest/src/poi/regions.ts`). Each region's authoritative import
  scope is its **country polygon** (the bundled `import-region-boundaries.geojson`),
  which bounds **stale-by-absence** tombstoning for that region alone (a re-import
  may tombstone rows inside the region's polygon that are absent from its extract,
  never rows outside it). The region bbox is used only by the producer's clip
  step, not for import scoping — adjacent countries' bboxes overlap, so a bbox
  scope would let a region tombstone a neighbour's roads (#1033). Shared with the
  producer's region env so refresh and import always target the same set; an
  unknown code fails fast rather than being silently dropped.
- **`OsmImportService.importAll()`** loops the configured regions and calls
  `importRegion()` for each, aggregating the upsert/carry-over/deactivate
  counts. A region whose extract is **absent, or parses to zero ways, is
  skipped — not tombstoned**: a folder-model region is an automated
  whole-country extract, so an empty result more likely signals a broken
  refresh than a genuinely road-less country, and tombstoning the region on
  that would be far worse than skipping it for one cycle. (This intentionally
  overrides `reconcile()`'s authoritative-empty-snapshot behavior, which exists
  for direct-source callers/tests that hand-supply a single-file tile — see the
  `importRegion` / `reconcile` doc comments.)

### The `complete_ways` contract

`osmium extract -b` (the producer's clip step) does **not** cut geometries —
its default `complete_ways` strategy emits every way that crosses the bbox
**whole**, extending beyond it. A way straddling two adjacent regions therefore
lands, complete, in **both** regions' `<code>.osm` files.

The importer reconciles this per region against the region's **country polygon**
(not its bounding rectangle — adjacent countries' rectangles overlap, and a
rectangle scope would let a later region tombstone an earlier region's roads that
fall in the shared strip, destroying their id + crowd history, #1033).
`importRegion` filters incoming rows to the polygon (`filterToRegion` — a PostGIS
`ST_Intersects` against `ST_GeomFromGeoJSON`) before reconcile compares against
existing rows, and reconcile loads the existing rows with the **same**
`ST_Intersects` polygon test (`loadExistingInRegion`) — so a border row is judged
identically against the incoming snapshot and the existing-row load, and only
**absent** rows inside that polygon are tombstoned. So:

- the extract only has to **cover** the country — the producer never clips
  geometries itself, and any neighbouring overhang is dropped by the polygon
  filter;
- a way straddling the edge is scoped to whichever country actually contains each
  part, and its shared segment upserts idempotently;
- stale-by-absence tombstoning stays sound per region, bounded by the region's
  own authoritative country polygon — never its overlapping rectangle, never a
  data-derived guess.

(This replaces the old single-file "the extract must be clipped to exactly this
rectangle" contract.)

## Producing extracts

The full operator recipe — manual prep and the automated scheduled-task setup
— lives in
[the runbook](../../../../../../docs/process/runbook.md#road-quality-extract-refresh-sub-project-b)
§ "Road-quality extract refresh (Sub-project B)"; it mirrors the POI OSM
refresh, filtered to the drivable-highway tag set instead of the POI one.
Quick manual example for one region (CZ):

```bash
# 1. Same Geofabrik extract the POI/routing infra uses
curl -L -o cz-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf

# 2. Filter to the drivable-highway set (packages/ingest/src/roads/road-tags.ts)
osmium tags-filter cz-latest.osm.pbf \
  w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,service,track \
  -o cz-road.osm.pbf

# 3. Extract to CZ's bbox from DEFAULT_REGIONS (complete_ways default — see
#    above; the importer scopes the overhang, so this just needs to COVER CZ)
osmium extract -b 12.09,48.55,18.86,51.06 cz-road.osm.pbf \
  -f osm -o "$TARMOTO_OSM_ROAD_IMPORT_DIR/cz.osm"
```

Repeat per region in the active set. The `apps/ingest` scheduled refresh
(`refresh-road-extracts.ts`, `pnpm road:refresh`) automates exactly this, for
every configured region, atomically.

## Config

| env                               | default               | meaning                                                                        |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `TARMOTO_OSM_ROAD_IMPORT_ENABLED` | `false`               | turn the weekly job on                                                         |
| `TARMOTO_OSM_ROAD_IMPORT_DIR`     | —                     | folder of per-region `<code>.osm` extracts (required when enabled)             |
| `TARMOTO_OSM_ROAD_IMPORT_REGIONS` | all `DEFAULT_REGIONS` | comma-separated ISO 3166-1 alpha-2 codes to import; an unknown code fails fast |

Dormant by default: an off tick is a cheap no-op.

## Memory & scale

Split/merge reconciliation is **region-scoped by design**: to decide whether a
way was split/merged (vs removed), it has to compare the whole incoming
snapshot against the existing rows in the same area, so a run buffers one
region's ~100 m segment rows and loads the matching existing rows into memory
(it can't be a pure per-chunk stream like a plain upsert).

The folder model gives this tiling "for free": each `DEFAULT_REGIONS` country
is already a self-contained `(extract, bbox)` pair, so `importAll()`'s
region-by-region loop bounds memory to one region at a time no matter how many
are configured — no more hand-splitting a country-sized file into bbox-clipped
sub-imports the way the old single-file contract required. (A way split
exactly across a region border loses history only at that seam; adjacent
regions still reconcile independently. In-engine sub-region tiling beyond
`DEFAULT_REGIONS` is a possible future enhancement if a single country ever
outgrows one import's memory budget.)

## Cadence & manual runs

Recurring weekly (Sunday 01:00 UTC, `road.import` queue) — before the POI
import (Sun 03:00) and the fun-zone recompute (Mon 04:00) so the road graph is
fresh for both. The extracts themselves refresh on their own earlier, staggered
schedule (the `apps/ingest` producer — see the runbook) so a fresh snapshot is
already on disk before this tick. A manual run is an ops enqueue on the
`road.import` queue (job name `run`), mirroring the other recurring jobs.

## Safety

The upsert never deletes, so a failed run can't wipe existing rows. Each
region's write happens inside its own DB transaction (in `reconcile()`),
committed before `importAll()` moves to the next region — so a region that
throws (a read/parse error) leaves every earlier region's import committed and
simply aborts the regions after it for that cycle; the whole job then fails and
BullMQ retries (safe: re-running is idempotent, so an already-succeeded region
just re-upserts its unchanged rows). An absent extract, or one that parses to
zero ways, is not an error — see the folder-model skip behavior above.

## Not yet wired for a live prod region

Enabling this in production should wait on **#809** (aggregate-safe road detail
/ exact clustered-member-set): until it lands, an imported way that accrues
quality surfaces in `/roads/best`, `/roads/:id`, and fun-zone detail via a
representative child id. Dev/staging can enable it freely.
