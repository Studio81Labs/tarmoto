# OSM → `road_segments` import (#781, folder model — Sub-project B)

Populates the base road network from OpenStreetMap and assigns the stable
`(osm_way_id, segment_index)` identity (#751) so re-imports preserve UUIDs and
all dependent FKs (`surface_readings`, `road_reviews`, `hazard_reports`,
`fun_zone_roads`).

## Pipeline

```
apps/ingest refresh-road-extracts.js → <extractDir>/<code>-r<row>c<col>-s<span>.osm (a tile grid per region)
                                                    │
                                                    ▼
         OsmImportService.importAll() loops the configured regions
                                                    │  per region: subdivideRegion → per tile:
                                                    ▼
  parseOsmXml → assembleWays → buildSegmentRows → importTile → filterToRegion(polygon ∩ tile bbox) → reconcile(scope)
```

- **Producer** — `apps/ingest` (a separate deployable) downloads each region's
  Geofabrik PBF, `osmium tags-filter`s it to the drivable-highway set
  (`ROAD_TAGS_FILTER_EXPRESSIONS` — the same `DRIVABLE_HIGHWAYS` list this
  module's `osm-tags.ts` gates on, so the two can't drift), then per tile of
  `subdivideRegion(region, tileSpanDeg)` `osmium extract -b`s it to that tile's
  bbox **padded** by `TILE_EXTRACT_PAD_DEG` (0.05° — `complete_ways` only
  selects a way with a node inside the clip bbox, so the pad keeps a way
  crossing the tile with no node inside the EXACT tile from being dropped) and
  atomically writes `<extractDir>/roadTileFileName(tile, tileSpanDeg)`
  (`<code>-r<row>c<col>-s<span>.osm`) — the output filename and the importer's
  reconcile scope stay the exact, unpadded tile. See
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
per-region, per-tile extracts, mirroring the POI importer's model:

- **`extractDir`** (`TARMOTO_OSM_ROAD_IMPORT_DIR`) — a directory of
  `<code>-r<row>c<col>-s<span>.osm` files, a deterministic **tile grid** per
  region (lower-case ISO 3166-1 alpha-2 code + 0-based row/col + the tile span
  with `.` replaced by `_`, e.g. `cz-r0c1-s2_5.osm`). The `-s<span>` suffix is a
  grid-identity discriminator (`roadTileFileName`): the importer always derives
  the span from ITS OWN `tileSpanDeg` config, never by parsing it back out of a
  filename, so a retuned span looks for differently-named files rather than
  reconciling a same-named-but-now-wrong-bbox stale file — a leftover from a
  previous span is simply "absent" (skipped), never mis-reconciled. The SAME
  shared volume the `apps/ingest` producer writes and this importer reads —
  both apps must point at the same path. `null`/unset skips the whole job
  (nothing to read).
- **`regions`** (`TARMOTO_OSM_ROAD_IMPORT_REGIONS`, default all
  `DEFAULT_REGIONS`) — the coverage list, the SAME 17-country list POI/FSQ use
  (`packages/ingest/src/poi/regions.ts`). Each tile's authoritative import scope
  is its region's **country polygon** (the bundled `import-region-boundaries.geojson`)
  **∩ the tile bbox**, which bounds **stale-by-absence** tombstoning to that tile's
  cell alone (a re-import may tombstone rows inside the polygon ∩ tile bbox that
  are absent from that tile's extract, never rows outside it). Scoping to the bbox
  alone would let a region tombstone a neighbour's roads in the overlapping strip
  (#1033); scoping to the polygon alone would let one tile tombstone the region's
  roads in the OTHER tiles. Shared with the producer's region env so refresh and
  import always target the same set; an unknown code fails fast rather than being
  silently dropped.
- **`tileSpanDeg`** (`TARMOTO_OSM_ROAD_TILE_SPAN_DEG`, default 2.5) — the max tile
  span the importer subdivides each region by (`subdivideRegion`). It **MUST match
  the producer's value** — both call `subdivideRegion` with it to derive the
  identical grid, so a mismatch means the importer looks for tile files the
  producer never wrote (or vice-versa). Invalid/≤0 fails fast. Since the span is
  also baked into `roadTileFileName`'s `-s<span>` suffix, a mismatch fails SAFE:
  the importer looks for a differently-named file, finds it absent, and skips —
  it can never reconcile a stale-grid file (same row/col, different bbox)
  against the wrong scope.
- **`OsmImportService.importAll()`** loops the configured regions and calls
  `importRegion()` for each; `importRegion()` subdivides the region into its tile
  grid and calls `importTile()` per tile, all aggregating the
  upsert/carry-over/deactivate counts. Only a tile whose extract is **absent** is
  skipped — never tombstoned (the producer writes a file for every cell, so a
  missing one is a partial/failed refresh, not authoritative). A **present** extract
  IS authoritative: the producer's refresh is atomic **keep-last-good** (a failed
  refresh keeps the previous extract and never writes an empty one), so a present
  zero-way / all-out-of-scope extract flows through to `reconcile()`, which
  tombstones the tile's now-absent in-scope rows — **OSM removals propagate** rather
  than lingering live as stale seed. To stay safe against a mis-produced / empty /
  misnamed extract, on a **dense tile** (at least `MIN_ROWS_FOR_TOMBSTONE_GUARD` =
  50 in-scope rows) a **stale-by-absence wipe of more than `MAX_TOMBSTONE_FRACTION`
  (50%) of them is WITHHELD** (rows kept live + a warn to rebuild), mirroring the POI
  importer's wipe-guard (row floor + fraction); definitive reused-key /
  out-of-scope-owner tombstones always apply. A **sparse tile** (below the row floor)
  has a tiny blast radius and a noisy ratio, so it propagates its removals freely
  even past 50% — otherwise a correct-but-small extract would withhold + warn every
  run forever. So a genuine partial removal (a few roads deleted/retagged) always
  propagates; only a dense cell "emptied" by a broken extract is held back.

### The `complete_ways` contract (and the extract pad)

`osmium extract -b` (the producer's clip step) does **not** cut geometries —
its default `complete_ways` strategy emits, **whole**, every way with **at
least one node** inside the bbox, extending beyond it. A way straddling two
adjacent tiles (or regions) therefore lands, complete, in **both** tiles'
`<code>-r<row>c<col>-s<span>.osm` files.

That same "at least one node inside the bbox" rule is also why the producer
clips a **padded** bbox (`paddedTileBbox`, `TILE_EXTRACT_PAD_DEG` = 0.05° ≈
5 km, `packages/ingest/src/roads/road-tiles.ts`) rather than the exact tile:
a way that crosses the tile but whose nearest nodes sit just outside the exact
tile has NO node inside it, so `complete_ways` would otherwise drop it from
this tile's extract entirely — a hole on first import, or a wrongful tombstone
on retile. The pad only widens the producer's `osmium` SELECTION; the output
filename and the importer's reconcile scope both stay the exact, unpadded tile
bbox, so the padded overhang is simply filtered out below (never double-counted).

The importer reconciles this **per tile** against the region's **country polygon
∩ the tile bbox** (not the bbox alone — adjacent countries' rectangles overlap,
and a bare-rectangle scope would let a later region tombstone an earlier region's
roads in the shared strip, #1033; and not the polygon alone — that would let one
tile tombstone the region's roads in the OTHER tiles). `importTile` filters
incoming rows to the polygon ∩ bbox (`filterToRegion` — a PostGIS `ST_Intersects`
pair against `ST_GeomFromGeoJSON` and `ST_MakeEnvelope`) before reconcile compares
against existing rows, and reconcile loads the existing rows with the **same**
combined test (`loadExistingInRegion`) — kept byte-for-byte parallel, so a
border/tile-seam row is judged identically against the incoming snapshot and the
existing-row load, and only **absent** rows inside that polygon ∩ bbox cell are
tombstoned. So:

- the extract only has to **cover** its tile — the producer never clips
  geometries itself (and pads its clip bbox so a node-less crossing way is
  still selected), and any neighbouring overhang is dropped by the combined
  filter;
- a way straddling a tile seam or country edge is scoped to whichever tile/country
  actually contains each part, and its shared segment upserts idempotently;
- stale-by-absence tombstoning stays sound per tile, bounded by the region's
  authoritative country polygon ∩ the tile bbox — never a country's overlapping
  rectangle, never another tile's cell, never a data-derived guess.

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

# 3. Extract to CZ's r0c0 tile bbox, PADDED by TILE_EXTRACT_PAD_DEG (0.05°) on
#    every side (complete_ways default — see above; the importer scopes the
#    overhang, so this just needs to COVER the tile). The importer reads
#    per-tile files, so a manual single-file prep is only valid at a tile span
#    >= the region (one r0c0 tile == the region bbox — here assuming
#    TARMOTO_OSM_ROAD_TILE_SPAN_DEG=10, hence the `-s10` suffix below). Real
#    coverage is a grid of subdivideRegion(region, TARMOTO_OSM_ROAD_TILE_SPAN_DEG)
#    tiles; the automated refresh below writes every
#    roadTileFileName(tile, tileSpanDeg), padding included.
osmium extract -b 12.04,48.50,18.91,51.11 cz-road.osm.pbf \
  -f osm -o "$TARMOTO_OSM_ROAD_IMPORT_DIR/cz-r0c0-s10.osm"
```

Repeat per region in the active set. The `apps/ingest` scheduled refresh
(`refresh-road-extracts.ts`, `pnpm road:refresh`) automates exactly this (tiling
each region), for
every configured region, atomically.

## Config

| env                               | default               | meaning                                                                               |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `TARMOTO_OSM_ROAD_IMPORT_ENABLED` | `false`               | turn the weekly job on                                                                |
| `TARMOTO_OSM_ROAD_IMPORT_DIR`     | —                     | folder of per-tile `<code>-r<row>c<col>-s<span>.osm` extracts (required when enabled) |
| `TARMOTO_OSM_ROAD_IMPORT_REGIONS` | all `DEFAULT_REGIONS` | comma-separated ISO 3166-1 alpha-2 codes to import; an unknown code fails fast        |
| `TARMOTO_OSM_ROAD_TILE_SPAN_DEG`  | `2.5`                 | max tile span (deg) to subdivide each region by; MUST match the producer's value      |

Dormant by default: an off tick is a cheap no-op.

## Memory & scale

Split/merge reconciliation is **scope-buffered by design**: to decide whether a
way was split/merged (vs removed), it has to compare the whole incoming
snapshot against the existing rows in the same area, so a run buffers one
**tile's** ~100 m segment rows and loads the matching existing rows into memory
(it can't be a pure per-chunk stream like a plain upsert).

**Sub-region tiling bounds this to one tile.** Each region is subdivided into a
deterministic non-overlapping grid of `<= TARMOTO_OSM_ROAD_TILE_SPAN_DEG`-degree
cells (`subdivideRegion`, shared with the `apps/ingest` producer so both derive
the identical grid), and `importRegion()` imports the region **tile-by-tile** —
one `<code>-r<row>c<col>-s<span>.osm` extract at a time. Each tile reconciles against the
country **polygon ∩ that tile's bbox**, so peak memory is bounded to one tile's
segment rows (plus the assembler's node map and the incoming array) **regardless
of the country's overall size**. `importAll()`'s region loop and `importRegion()`'s
tile loop both aggregate counts without holding more than one tile at once.

Because a tile is bounded (default 2.5° ≈ a couple hundred km per side), large
countries (**DE / IT / PL**) are now safe to enable — a whole-country buffer,
which could OOM the worker, never forms. Tune the span down per country density
if a single tile is still too heavy (it must match the producer's value, or the
importer looks for tiles the producer never wrote). The no-cross-**region** wipe
(#1033, country-polygon scope) and the no-cross-**tile** wipe (the `∩ tile bbox`
half of the scope) both hold: a tile only ever tombstones absent roads inside its
own polygon ∩ bbox cell. (A way split exactly across a tile seam or region border
loses history only at that seam; adjacent tiles/regions still reconcile
independently — a seam way is emitted COMPLETE into both tiles by `complete_ways`
and upserts idempotently.)

A present-but-empty (or shrunken) tile is **authoritative**: its removed roads are
tombstoned so OSM deletions propagate — but on a **dense** cell (at least
`MIN_ROWS_FOR_TOMBSTONE_GUARD` = 50 in-scope rows) a stale-by-absence wipe of more
than `MAX_TOMBSTONE_FRACTION` (50%) of them is **withheld** (kept live + a warn), so
one mis-produced / empty / misnamed extract can't deactivate most of a cell in a
single run (mirrors the POI importer's row-floor + fraction wipe-guard). A **sparse**
cell (below the floor) has a tiny blast radius, so it propagates removals freely even
past 50% — never withheld/warned forever against a correct-but-small extract. Only an
**absent** file still skips outright.

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
just re-upserts its unchanged rows). An **absent** extract is skipped (not an
error — a partial refresh); a **present** extract is authoritative and reconciled
even when empty, so its removed roads are tombstoned, with the wipe-guard (a 50-row
floor + a 50% stale-by-absence fraction) withholding an implausible mass-wipe on a
dense cell — see the folder-model behavior above.

## Not yet wired for a live prod region

Enabling this in production should wait on **#809** (aggregate-safe road detail
/ exact clustered-member-set): until it lands, an imported way that accrues
quality surfaces in `/roads/best`, `/roads/:id`, and fun-zone detail via a
representative child id. Dev/staging can enable it freely.
