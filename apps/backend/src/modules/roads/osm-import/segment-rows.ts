import * as GeoJSON from 'geojson';
import type { SurfaceType, QualitySource } from '@tarmoto/shared';
import { type LatLng, segmentWay } from './segmentation.js';
import {
  type OsmTags,
  isDrivableHighway,
  roadFieldsFromTags,
} from './osm-tags.js';
import { qualitySeedFromTags } from './quality-seed.js';

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
  /** OSM-derived quality prior [1,5], refreshed every import (design 2026-07-15). */
  osm_quality_seed: number | null;
  /** Which OSM signal produced `osm_quality_seed`. */
  quality_source: QualitySource | null;
  /** Effective quality — seeded to `osm_quality_seed` on INSERT so a rider-less
   *  segment shows quality immediately; the DB blend + upsert gate own it after. */
  quality_score: number | null;
}

/** Build the `road_segments` rows for one OSM way (empty for non-drivable or
 *  degenerate geometry). */
export function waySegmentRows(way: OsmWay): RoadSegmentRow[] {
  if (!isDrivableHighway(way.tags)) return [];
  const fields = roadFieldsFromTags(way.tags);
  const seed = qualitySeedFromTags(way.tags);
  const osm_way_id = String(way.id);
  return (
    segmentWay(way.coords)
      // Drop zero-length segments (a way whose nodes are all coincident) so no
      // degenerate `length_m = 0` LineString reaches distance-weighted scoring or
      // spatial queries. Index AFTER filtering keeps `segment_index` contiguous.
      .filter((seg) => seg.length_m > 0)
      .map((seg, index) => ({
        osm_way_id,
        segment_index: index, // 0-based ordinal within the way (#751)
        geom: {
          type: 'LineString' as const,
          coordinates: seg.coords.map((p) => [p.lng, p.lat]), // GeoJSON [lng, lat]
        },
        length_m: seg.length_m,
        curviness_score: seg.curviness_score,
        ...fields,
        osm_quality_seed: seed.score,
        quality_source: seed.source,
        quality_score: seed.score,
      }))
  );
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
