# OSM → `road_segments` import (#781)

Populates the base road network from OpenStreetMap and assigns the stable
`(osm_way_id, segment_index)` identity (#751) so re-imports preserve UUIDs and
all dependent FKs (`surface_readings`, `road_reviews`, `hazard_reports`,
`fun_zone_roads`).

## Pipeline

```
region.osm → parseOsmXml → assembleWays → buildSegmentRows → OsmImportService.upsert
```

- `osm-xml-source.ts` — streams an `.osm` XML file into flat OSM primitives.
- `osm-assemble.ts` — resolves node refs into `OsmWay` objects with geometry.
- `segmentation.ts` / `osm-tags.ts` / `segment-rows.ts` — split each way into
  ~100 m segments and derive per-segment columns.
- `osm-import.service.ts` — bulk-upserts `ON CONFLICT (osm_way_id, segment_index)`,
  preserving crowdsourced quality/confidence/reading_count and (via the durable
  `surface_from_reading` flag, #796) rider-classified surfaces.

## Operator prep

The importer reads `.osm` XML, not `.osm.pbf` directly (the maintained JS PBF
parsers are stale; osmium decodes PBF far better). Convert the Geofabrik extract
once, then point the job at the result:

```bash
# same extract the routing infra uses
curl -L -o czech-republic-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf
osmium cat czech-republic-latest.osm.pbf -o /data/czech.osm
```

### Set a region for stale detection

To let the importer **tombstone** removed roads, set `TARMOTO_OSM_ROAD_IMPORT_BBOX` and
prepare the extract for the SAME rectangle:

```bash
# minLng,minLat,maxLng,maxLat — identical to TARMOTO_OSM_ROAD_IMPORT_BBOX
osmium extract -b 12.09,48.55,18.86,51.06 \
  czech-republic-latest.osm.pbf -o /data/czech.osm
```

`osmium extract -b` does not clip geometries — it keeps every complete way that
crosses the bbox — but the importer **constrains generated rows to the configured
bbox** itself, so a way straddling the edge only reconciles in the tile(s) it
actually intersects. That means the extract just has to COVER the region; the
importer handles the overhang. The bbox you configure must still match the region
the extract covers.

Without a region the importer does not tombstone rows for being **absent** from
the snapshot (it can't tell "removed" from "outside this extract"), so any extract
is fine there. It still deactivates a row whose exact `(osm_way_id, segment_index)`
the snapshot reassigns to a different road — that's definitive key reuse, not a
bbox guess.

## Config

| env                               | default | meaning                                                                                     |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `TARMOTO_OSM_ROAD_IMPORT_ENABLED` | `false` | turn the weekly job on                                                                      |
| `TARMOTO_OSM_ROAD_IMPORT_FILE`    | —       | absolute path to the prepared `.osm` file (required when enabled)                           |
| `TARMOTO_OSM_ROAD_IMPORT_BBOX`    | —       | `minLng,minLat,maxLng,maxLat` region for stale detection; the extract must be clipped to it |

Dormant by default: an off tick is a cheap no-op.

## Memory & scale

Split/merge reconciliation is **region-scoped by design**: to decide whether a way
was split/merged (vs removed), it has to compare the whole incoming snapshot
against the existing rows in the same area, so a run buffers the region's ~100 m
segment rows and loads the matching existing rows into memory (it can't be a pure
per-chunk stream like a plain upsert). Size the region to fit the worker heap.

For a large area, **tile it into several bbox-clipped sub-imports** rather than one
country-sized file — each `(TARMOTO_OSM_ROAD_IMPORT_FILE, TARMOTO_OSM_ROAD_IMPORT_BBOX)` pair
is a self-contained region, so N adjacent tiles reconcile independently and bound
memory to one tile. (A way split exactly across a tile edge loses history only at
that seam; keep tiles comfortably larger than a single way. In-engine auto-tiling
is a possible future enhancement.)

## Cadence & manual runs

Recurring weekly (Sunday 01:00 UTC, `road.import` queue) — before the POI import
(Sun 03:00) and the fun-zone recompute (Mon 04:00) so the road graph is fresh
for both. A manual run is an ops enqueue on the `road.import` queue (job name
`run`), mirroring the other recurring jobs.

## Safety

The upsert never deletes, so a partial or failed run (stream/parse error) can't
wipe existing rows — it fails fast and BullMQ retries. Re-running the same
extract is idempotent and preserves every segment UUID.

## Not yet wired for a live prod region

Enabling this in production should wait on **#809** (aggregate-safe road detail /
exact clustered-member-set): until it lands, an imported way that accrues quality
surfaces in `/roads/best`, `/roads/:id`, and fun-zone detail via a representative
child id. Dev/staging can enable it freely.
