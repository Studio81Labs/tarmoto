import * as GeoJSON from 'geojson';
import type { SurfaceType } from '@tarmoto/shared';
import { type LatLng, segmentWay } from './segmentation.js';
import {
  type OsmTags,
  isDrivableHighway,
  roadFieldsFromTags,
} from './osm-tags.js';

/**
 * The way → `road_segments` rows transform (#781): the slice between the OSM
 * source (a PBF parser, separate) and the DB upsert (separate). Pure and
 * side-effect-free, so it's unit-testable from synthetic ways. It filters to
 * drivable roads, splits each way into ~100 m segments, and emits a row per
 * segment carrying the stable `(osm_way_id, segment_index)` identity (#751)
 * plus the OSM-derived columns.
 */

/** A single OSM way with its node geometry already resolved. */
export interface OsmWay {
  /** OSM way id — stored as a string (`road_segments.osm_way_id` is bigint). */
  id: number | string;
  tags: OsmTags;
  /** Node coordinates in order along the way. */
  coords: LatLng[];
}

/**
 * A source of OSM ways for the importer. The PBF/streaming parser implements
 * this (a later slice); the transform below consumes any iterable, so it's
 * testable without a real extract.
 */
export type OsmWaySource = Iterable<OsmWay> | AsyncIterable<OsmWay>;

/** A `road_segments` row built from one ~100 m slice of an OSM way. */
export interface RoadSegmentRow {
  osm_way_id: string;
  segment_index: number;
  geom: GeoJSON.LineString;
  length_m: number;
  curviness_score: number;
  road_name: string | null;
  road_number: string | null;
  surface_type: SurfaceType;
}

/** Build the `road_segments` rows for one OSM way (empty for non-drivable or
 *  degenerate geometry). */
export function waySegmentRows(way: OsmWay): RoadSegmentRow[] {
  if (!isDrivableHighway(way.tags)) return [];
  const fields = roadFieldsFromTags(way.tags);
  const osm_way_id = String(way.id);
  return segmentWay(way.coords).map((seg, index) => ({
    osm_way_id,
    segment_index: index, // 0-based ordinal within the way (#751)
    geom: {
      type: 'LineString',
      coordinates: seg.coords.map((p) => [p.lng, p.lat]), // GeoJSON [lng, lat]
    },
    length_m: seg.length_m,
    curviness_score: seg.curviness_score,
    ...fields,
  }));
}

/**
 * Stream `road_segments` rows for every drivable way in `ways`. Lazy (a
 * generator) so a country-sized source never materialises all rows at once —
 * the upsert slice batches from here.
 */
export async function* buildSegmentRows(
  ways: OsmWaySource,
): AsyncGenerator<RoadSegmentRow> {
  for await (const way of ways) {
    yield* waySegmentRows(way);
  }
}
