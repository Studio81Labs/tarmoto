import type { Readable } from 'node:stream';
import sax from 'sax';
import type { OsmPrimitive, OsmWayRef } from './osm-assemble.js';

/**
 * Streaming reader for OSM XML (`.osm`) — the byte-level decoder slice of #781.
 * Yields the flat {@link OsmPrimitive} stream {@link assembleWays} consumes, so
 * the ingest chain is: `.osm` → this → assembleWays → buildSegmentRows → upsert.
 *
 * We read `.osm` XML rather than `.osm.pbf` directly: the maintained JS PBF
 * parsers are stale, and osmium decodes PBF far better than anything in-process.
 * So the operator prep step (documented alongside the extract download) converts
 * once with `osmium cat region.osm.pbf -o region.osm`, and this reads the XML
 * with the maintained, zero-dependency `sax` parser. Direct PBF is a possible
 * later optimisation; the `OsmPrimitive` boundary means it would not touch
 * `assembleWays` or anything downstream.
 *
 * `sax` is push-based; this bridges it to a pull-based async generator with
 * bounded buffering — the source stream is paused when the consumer (ending in
 * an awaited DB upsert) falls behind, so a large extract does not accumulate in
 * memory.
 */

/** Pause the source once this many parsed primitives are buffered unconsumed. */
const HIGH_WATER = 1000;
/** Resume the source once the buffer drains back to this. */
const LOW_WATER = 250;

export async function* parseOsmXml(
  input: Readable,
): AsyncGenerator<OsmPrimitive> {
  const parser = sax.createStream(true, { trim: true, position: false });

  const queue: OsmPrimitive[] = [];
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

  let way: OsmWayRef | null = null;

  parser.on('opentag', (tag) => {
    // Attributes are absent-keyed, so every lookup is `string | undefined`.
    const attributes = tag.attributes as Record<string, string | undefined>;
    switch (tag.name) {
      case 'node': {
        const { id, lat, lon } = attributes;
        // A node without id/coordinates is malformed OSM — skip it.
        if (id === undefined || lat === undefined || lon === undefined) break;
        queue.push({ type: 'node', id, lat: Number(lat), lon: Number(lon) });
        maybePause();
        signal();
        break;
      }
      case 'way':
        // A way must carry an id (its identity + conflict key); skip if absent.
        way =
          attributes.id === undefined
            ? null
            : { type: 'way', id: attributes.id, tags: {}, refs: [] };
        break;
      case 'nd':
        if (way && attributes.ref !== undefined) way.refs.push(attributes.ref);
        break;
      case 'tag':
        // Only way tags matter downstream; node tags are ignored (way is null).
        if (way && attributes.k !== undefined)
          way.tags[attributes.k] = attributes.v;
        break;
      default:
        break;
    }
  });

  parser.on('closetag', (name) => {
    if (name === 'way' && way) {
      queue.push(way);
      way = null;
      maybePause();
      signal();
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
      if (queue.length > 0) {
        const primitive = queue.shift() as OsmPrimitive;
        maybeResume();
        yield primitive;
        continue;
      }
      if (failure !== null) {
        // Rethrow the captured stream/parse error (sax + streams emit Errors).
        throw failure instanceof Error
          ? failure
          : new Error('OSM XML parsing failed');
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
