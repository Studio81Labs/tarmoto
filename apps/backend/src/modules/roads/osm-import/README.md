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

### Bbox-clip when you set a region (required for stale detection)

If you set `TARMOTO_OSM_IMPORT_BBOX` (so the importer may **tombstone** removed
roads), the `.osm` file MUST be clipped to that exact rectangle — otherwise a
row that sits inside the rectangle but outside the extract's real (polygon) shape
would be tombstoned even though the file never mentions it. Clip with the SAME
bounds you configure:

```bash
# minLng,minLat,maxLng,maxLat — identical to TARMOTO_OSM_IMPORT_BBOX
osmium extract -b 12.09,48.55,18.86,51.06 \
  czech-republic-latest.osm.pbf -o /data/czech.osm
```

Without a region the importer never tombstones (it only carries over + inserts),
so an unclipped extract is fine there.

## Config

| env                          | default | meaning                                                                                     |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `TARMOTO_OSM_IMPORT_ENABLED` | `false` | turn the weekly job on                                                                      |
| `TARMOTO_OSM_IMPORT_FILE`    | —       | absolute path to the prepared `.osm` file (required when enabled)                           |
| `TARMOTO_OSM_IMPORT_BBOX`    | —       | `minLng,minLat,maxLng,maxLat` region for stale detection; the extract must be clipped to it |

The extract itself bounds the region — there is no bbox. Dormant by default:
an off tick is a cheap no-op.

## Cadence & manual runs

Recurring weekly (Sunday 01:00 UTC, `osm.import` queue) — before the POI import
(Sun 03:00) and the fun-zone recompute (Mon 04:00) so the road graph is fresh
for both. A manual run is an ops enqueue on the `osm.import` queue (job name
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
