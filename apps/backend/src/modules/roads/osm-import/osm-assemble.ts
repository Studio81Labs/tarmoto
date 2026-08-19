import type { LatLng } from './segmentation.js';
import type { OsmTags } from './osm-tags.js';
import type { OsmWay } from './segment-rows.js';

/**
 * Assembles OSM ways with resolved geometry (#781) — the middle of the ingest
 * pipeline, between a byte-level extract decoder (a PBF/XML adapter, a separate
 * slice) and {@link OsmImportService}. A decoder emits flat primitives (nodes
 * carry coordinates; ways carry only node-id references); this resolves each
 * way's references into an ordered coordinate list and yields the `OsmWay`
 * objects the importer consumes.
 *
 * Format-agnostic and side-effect-free, so it's unit-testable from synthetic
 * primitives without a real extract or a parsing dependency.
 */

/** A node primitive: an id and its coordinate. */
export interface OsmNode {
  type: 'node';
  id: number | string;
  lat: number;
  lon: number;
}

/** A way primitive: tags plus the node ids it traverses, in order. */
export interface OsmWayRef {
  type: 'way';
  id: number | string;
  tags: OsmTags;
  /** Node ids in order along the way (OSM `nd` refs). */
  refs: (number | string)[];
}

export type OsmPrimitive = OsmNode | OsmWayRef;
export type OsmPrimitiveSource =
  Iterable<OsmPrimitive> | AsyncIterable<OsmPrimitive>;

/**
 * Resolve `ways` node references against `nodes` seen so far, yielding an
 * `OsmWay` per resolvable way.
 *
 * Streams in a single pass and buffers only node coordinates (a way's refs are
 * resolved against nodes already seen) — this relies on the OSM ordering
 * convention that all nodes precede the ways referencing them, which sorted
 * extracts (Geofabrik PBF/XML) satisfy. Only node coordinates are held in
 * memory, so a region-bounded extract stays tractable; a full-planet extract
 * would need a disk-backed node cache (a scaling follow-up).
 *
 * A way is skipped (not yielded) when any referenced node is absent — e.g. a
 * node clipped out at a region boundary — or when fewer than two references
 * resolve, since a single point is not a drawable segment.
 */
export async function* assembleWays(
  primitives: OsmPrimitiveSource,
): AsyncGenerator<OsmWay> {
  const nodes = new Map<string, LatLng>();

  for await (const primitive of primitives) {
    if (primitive.type === 'node') {
      nodes.set(String(primitive.id), {
        lat: primitive.lat,
        lng: primitive.lon,
      });
      continue;
    }

    const coords: LatLng[] = [];
    let complete = true;
    for (const ref of primitive.refs) {
      const coord = nodes.get(String(ref));
      if (!coord) {
        complete = false;
        break;
      }
      coords.push(coord);
    }
    if (!complete || coords.length < 2) continue;

    yield { id: primitive.id, tags: primitive.tags, coords };
  }
}
