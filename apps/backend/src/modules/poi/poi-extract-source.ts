import type { Readable } from 'node:stream';
import sax from 'sax';
import type {
  AccommodationPoi,
  ImportedPoi,
} from './poi-provider.interface.js';
import {
  mapOsmElementToPoi,
  type OsmPoiElement,
} from './providers/osm-poi-tags.js';

/**
 * Streaming reader for a `.osm` XML extract → POI rows (#850) — the bulk-import
 * counterpart to the live Overpass fetch. Reuses the exact same
 * {@link mapOsmElementToPoi} tag→row mapping the provider does, so a region
 * imported from an osmium-filtered Geofabrik extract produces byte-for-byte
 * identical `pois` rows to the Overpass path.
 *
 * Mirrors `roads/osm-import/osm-xml-source.ts`: we read `.osm` XML (osmium
 * converts the `.osm.pbf` once, `osmium cat region.osm.pbf -o region.osm`)
 * with the maintained, zero-dependency `sax` parser and bridge its push-based
 * events to a pull-based async generator with bounded buffering — the source is
 * paused when the consumer (ending in an awaited DB upsert) falls behind, so a
 * country-sized extract never accumulates in memory.
 *
 * Assembly is folded in (unlike roads, which emits flat primitives for a
 * separate `assembleWays` pass): node coordinates are buffered in a Map, way
 * node-refs in a second Map, and every tagged element is reduced to a single
 * representative point — a node's own coordinate, a way's node-centroid, or a
 * relation's centroid over its member nodes + member ways' nodes — because a POI
 * needs one point, not a polyline or a multipolygon. This relies on the OSM
 * ordering convention — nodes precede ways precede the relations referencing
 * them, which sorted Geofabrik extracts satisfy. Untagged nodes/ways are pure
 * geometry (referenced by ways/relations) and never yield a POI themselves.
 *
 * Relations matter because the runbook's `osmium tags-filter nwr/...` keeps
 * them, and the Overpass path served them via `out center`: area-mapped POIs
 * (hotels, campsites, rest/service areas, multipolygon viewpoints) are modeled
 * as relations, so dropping them would both lose those rows and wrongly
 * tombstone existing `osm:relation:*` rows as absent on re-import.
 */

/** Pause the source once this many mapped POI rows are buffered unconsumed. */
const HIGH_WATER = 1000;
/** Resume the source once the buffer drains back to this. */
const LOW_WATER = 250;

type PoiResult = { poi: ImportedPoi } | { accommodation: AccommodationPoi };

interface PendingNode {
  id: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

interface PendingWay {
  id: string;
  tags: Record<string, string>;
  /** Node ids in order along the way (OSM `nd` refs). */
  refs: string[];
}

interface PendingRelation {
  id: string;
  tags: Record<string, string>;
  /** `<member type="node">` refs — direct point members. */
  memberNodeRefs: string[];
  /** `<member type="way">` refs — resolved via the buffered way→node-ref map. */
  memberWayRefs: string[];
}

interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A closed OSM way (the normal polygon representation) repeats its first node
 * as its last, so drop that duplicate closing ref before averaging — otherwise
 * the centroid is biased toward the shared vertex (a square `1,2,3,4,1` would
 * land at 0.8,0.8, not the centre 1,1).
 */
function withoutClosingRef(refs: string[]): string[] {
  return refs.length > 1 && refs[0] === refs[refs.length - 1]
    ? refs.slice(0, -1)
    : refs;
}

/**
 * Reduce a way to one representative point: the arithmetic mean of its resolved
 * node coordinates. Returns null (way skipped) when any referenced node is
 * absent — e.g. clipped at the extract boundary — or fewer than two resolve,
 * matching `assembleWays`'s "missing nodes / <2 coords" skip so a partial
 * polygon can't place a POI at a distorted point.
 */
function wayCentroid(
  way: PendingWay,
  nodes: Map<string, LatLng>,
): LatLng | null {
  const coords: LatLng[] = [];
  for (const ref of withoutClosingRef(way.refs)) {
    const coord = nodes.get(ref);
    if (!coord) return null;
    coords.push(coord);
  }
  if (coords.length < 2) return null;
  let sumLat = 0;
  let sumLng = 0;
  for (const coord of coords) {
    sumLat += coord.lat;
    sumLng += coord.lng;
  }
  return { lat: sumLat / coords.length, lng: sumLng / coords.length };
}

/**
 * Reduce a relation to one representative point: the arithmetic mean of every
 * coordinate its members resolve to — direct `node` members plus every node of
 * each `way` member (looked up in the buffered way→node-ref map). Best-effort,
 * unlike {@link wayCentroid}: a multipolygon can have many members and some may
 * be clipped, so we average whatever resolves and only skip the relation when
 * *nothing* resolves. This mirrors the Overpass path's `out center`, which
 * likewise gives a relation a single representative point.
 */
function relationCentroid(
  relation: PendingRelation,
  nodes: Map<string, LatLng>,
  wayRefs: Map<string, string[]>,
): LatLng | null {
  const coords: LatLng[] = [];
  for (const ref of relation.memberNodeRefs) {
    const coord = nodes.get(ref);
    if (coord) coords.push(coord);
  }
  for (const wayId of relation.memberWayRefs) {
    const refs = wayRefs.get(wayId);
    if (!refs) continue;
    for (const nodeRef of withoutClosingRef(refs)) {
      const coord = nodes.get(nodeRef);
      if (coord) coords.push(coord);
    }
  }
  if (coords.length < 1) return null;
  let sumLat = 0;
  let sumLng = 0;
  for (const coord of coords) {
    sumLat += coord.lat;
    sumLng += coord.lng;
  }
  return { lat: sumLat / coords.length, lng: sumLng / coords.length };
}

export async function* parsePoiExtract(
  input: Readable,
): AsyncGenerator<PoiResult> {
  const parser = sax.createStream(true, { trim: true, position: false });

  const queue: PoiResult[] = [];
  // Node coordinates buffered for way-centroid resolution — every valid node,
  // tagged or not, since a tagged POI node can also be a way's geometry vertex.
  const nodes = new Map<string, LatLng>();
  // Way → its node-ref list, buffered so a relation's `way` members can be
  // resolved once it closes. Bounded the same way as `nodes`: an osmium
  // tag-filtered + reference-completed extract only carries the ways the kept
  // features reference, not the whole planet.
  const wayRefs = new Map<string, string[]>();
  let ended = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  let paused = false;
  const maybePause = (): void => {
    if (!paused && queue.length >= HIGH_WATER) {
      input.pause();
      paused = true;
    }
  };
  const maybeResume = (): void => {
    if (paused && queue.length <= LOW_WATER) {
      input.resume();
      paused = false;
    }
  };

  /** Map a normalized element and enqueue it when it's a POI/accommodation. */
  const emit = (el: OsmPoiElement): void => {
    const result = mapOsmElementToPoi(el);
    if (result) {
      queue.push(result);
      maybePause();
      signal();
    }
  };

  // The element currently open. Node tags matter here (a node can BE a POI), so
  // unlike the roads source we accumulate a node's child `<tag>`s until its
  // close, rather than emitting it on the opening tag. Only one of the three is
  // ever open at a time — node/way/relation are flat siblings under `<osm>`.
  let node: PendingNode | null = null;
  let way: PendingWay | null = null;
  let relation: PendingRelation | null = null;

  parser.on('opentag', (tag) => {
    // Attributes are absent-keyed, so every lookup is `string | undefined`.
    const attributes = tag.attributes as Record<string, string | undefined>;
    switch (tag.name) {
      case 'node': {
        const { id, lat, lon } = attributes;
        // A node without id/coordinates is malformed OSM — skip it.
        node =
          id === undefined || lat === undefined || lon === undefined
            ? null
            : { id, lat: Number(lat), lng: Number(lon), tags: {} };
        break;
      }
      case 'way':
        // A way must carry an id (its identity + conflict key); skip if absent.
        way =
          attributes.id === undefined
            ? null
            : { id: attributes.id, tags: {}, refs: [] };
        break;
      case 'relation':
        // A relation must carry an id (its identity + conflict key); skip if
        // absent, exactly like a way.
        relation =
          attributes.id === undefined
            ? null
            : {
                id: attributes.id,
                tags: {},
                memberNodeRefs: [],
                memberWayRefs: [],
              };
        break;
      case 'nd':
        if (way && attributes.ref !== undefined) way.refs.push(attributes.ref);
        break;
      case 'member':
        // Collect a relation's node/way members for centroid resolution; nested
        // relation members are ignored (we don't recurse into sub-relations).
        if (relation && attributes.ref !== undefined) {
          if (attributes.type === 'node')
            relation.memberNodeRefs.push(attributes.ref);
          else if (attributes.type === 'way')
            relation.memberWayRefs.push(attributes.ref);
        }
        break;
      case 'tag':
        // A tag belongs to whichever element is open — node, then way, then
        // relation, matching the nodes → ways → relations document order.
        if (attributes.k !== undefined && attributes.v !== undefined) {
          if (node) node.tags[attributes.k] = attributes.v;
          else if (way) way.tags[attributes.k] = attributes.v;
          else if (relation) relation.tags[attributes.k] = attributes.v;
        }
        break;
      default:
        break;
    }
  });

  parser.on('closetag', (name) => {
    if (name === 'node' && node) {
      // Buffer the coordinate for later way resolution, then classify — but
      // only tagged nodes are POI candidates; an untagged node is pure geometry.
      nodes.set(node.id, { lat: node.lat, lng: node.lng });
      if (Object.keys(node.tags).length > 0) {
        emit({
          osmType: 'node',
          osmId: node.id,
          lat: node.lat,
          lng: node.lng,
          tags: node.tags,
        });
      }
      node = null;
    } else if (name === 'way' && way) {
      // Buffer the node-ref list for any relation that references this way
      // later — every way, tagged or not, since a relation's geometry ways are
      // usually untagged (the tags live on the relation).
      wayRefs.set(way.id, way.refs);
      // Only tagged ways can be a POI; resolve the centroid of their nodes.
      if (Object.keys(way.tags).length > 0) {
        const centre = wayCentroid(way, nodes);
        if (centre) {
          emit({
            osmType: 'way',
            osmId: way.id,
            lat: centre.lat,
            lng: centre.lng,
            tags: way.tags,
          });
        }
      }
      way = null;
    } else if (name === 'relation' && relation) {
      // Only tagged relations are POI candidates; reduce their member geometry
      // (direct nodes + member ways' nodes) to one representative centroid.
      if (Object.keys(relation.tags).length > 0) {
        const centre = relationCentroid(relation, nodes, wayRefs);
        if (centre) {
          emit({
            osmType: 'relation',
            osmId: relation.id,
            lat: centre.lat,
            lng: centre.lng,
            tags: relation.tags,
          });
        }
      }
      relation = null;
    }
  });

  parser.on('error', (err) => {
    failure = err;
    ended = true;
    signal();
  });
  parser.on('end', () => {
    ended = true;
    signal();
  });
  input.on('error', (err) => {
    failure = err;
    ended = true;
    signal();
  });

  input.pipe(parser);

  try {
    while (true) {
      // Check for a parse/read failure BEFORE draining the queue: on a doomed
      // extract, fail fast instead of yielding (and upserting) up to HIGH_WATER
      // more buffered rows that will be discarded when the import throws.
      if (failure !== null) {
        // Rethrow the captured stream/parse error (sax + streams emit Errors).
        throw failure instanceof Error
          ? failure
          : new Error('OSM XML parsing failed');
      }
      if (queue.length > 0) {
        const result = queue.shift() as PoiResult;
        maybeResume();
        yield result;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // Runs on normal completion, on throw, AND when the consumer abandons the
    // generator early (e.g. the downstream upsert throws mid-stream): stop the
    // source promptly so a large extract doesn't keep the fd + parser work alive
    // after the import has already failed.
    input.unpipe(parser);
    input.destroy();
  }
}
