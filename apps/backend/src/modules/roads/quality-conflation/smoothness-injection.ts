import type { Readable, Writable } from 'node:stream';
import sax from 'sax';
import type { OsmSmoothness } from './quality-smoothness.js';

/**
 * Streaming OSM-XML rewriter that injects a `smoothness` tag onto selected ways
 * (#779 Phase 2, ADR-0005) — the write side of the quality conflation.
 *
 * GraphHopper weights routes off the stock `smoothness` encoded value, so the
 * conflation bakes our per-way quality (from {@link QualityConflationService})
 * into a derived `.osm` extract that GraphHopper re-imports. This transform
 * reads the same `.osm` XML the importer consumes (osmium-produced; see the
 * importer README), passes every element through unchanged, and for each way
 * whose id is in `assignments` writes `<tag k="smoothness" v="…"/>` so
 * re-running is **idempotent** and never duplicates the tag.
 *
 * The conflation **owns the `smoothness` channel** (ADR-0005): every source
 * `smoothness` tag is stripped, whether or not the way is matched. A matched way
 * gets our conflated value; an unscored way is left with **no** `smoothness` so
 * it reads `MISSING`/neutral and is never penalised by the request-time
 * `preferQuality` rule. (A road's other tags are untouched — only `smoothness`.)
 *
 * Output is **semantically** faithful, not byte-faithful: elements normalise to
 * open/close form (`<node …></node>` for a source `<node …/>`) and attribute
 * order/content is preserved. GraphHopper parses elements/attributes/tags, not
 * whitespace, so this is exactly what a re-import needs. The whole extract is
 * re-emitted (nodes, ways, relations, bounds) — only ways are modified — so the
 * derived file is a valid standalone extract, not a fragment.
 *
 * Streaming (via `sax`, matching the importer) with output backpressure: only
 * one way is ever held in flight, so a national extract rewrites in bounded
 * memory. On any terminal path — success, parse error, or output error — the
 * input is unpiped and destroyed (mirroring the importer), so a rejection never
 * leaves the source reading while a retry is scheduled. It does not `end()` the
 * output: the caller flushes and renames it.
 */
export async function injectSmoothnessTags(
  input: Readable,
  output: Writable,
  assignments: ReadonlyMap<string, OsmSmoothness>,
): Promise<{ waysTagged: number }> {
  return await new Promise<{ waysTagged: number }>((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false, position: false });
    let waysTagged = 0;
    // Smoothness to inject for the way currently being streamed (null = the way
    // is unmatched, so pass it through verbatim).
    let waySmoothness: OsmSmoothness | null = null;
    let inWay = false;
    // True while dropping a matched way's existing `<tag k="smoothness">` (we
    // re-emit our own at the way's close instead).
    let skippingSmoothness = false;
    let awaitingDrain = false;

    const write = (chunk: string): void => {
      if (!output.write(chunk) && !awaitingDrain) {
        // Output is congested: stop reading until it drains so a large extract
        // doesn't buffer unbounded in the writable.
        awaitingDrain = true;
        input.pause();
        output.once('drain', () => {
          awaitingDrain = false;
          input.resume();
        });
      }
    };

    // Emit the XML declaration once, deterministically: sax's handling of the
    // `<?xml …?>` declaration differs from ordinary processing instructions
    // (and versions vary on whether it fires an event), so we write our own and
    // drop any `xml`-named PI to avoid duplicating it. OSM extracts are UTF-8.
    write('<?xml version="1.0" encoding="UTF-8"?>\n');
    parser.on('processinginstruction', (pi: { name: string; body: string }) => {
      if (pi.name.toLowerCase() === 'xml') return;
      write(`<?${pi.name} ${pi.body}?>`);
    });

    parser.on('opentag', (tag) => {
      const attrs = tag.attributes as Record<string, string | undefined>;
      if (tag.name === 'way') {
        inWay = true;
        waySmoothness =
          attrs.id !== undefined ? (assignments.get(attrs.id) ?? null) : null;
      } else if (inWay && tag.name === 'tag' && attrs.k === 'smoothness') {
        // The conflation OWNS the `smoothness` channel (ADR-0005): strip ANY
        // source smoothness — matched or not. On a matched way our value is
        // re-written at the way's close (idempotent); on an UNSCORED way the tag
        // is dropped entirely so the way becomes MISSING/neutral and is never
        // penalised by the request-time `preferQuality` rule. Leaving a source
        // `smoothness=bad` on a way we have no score for would let GraphHopper
        // de-weight a road with no crowdsourced quality — the exact contract
        // violation ADR-0005 forbids.
        skippingSmoothness = true;
        return;
      }
      write(`<${tag.name}${serializeAttrs(attrs)}>`);
    });

    parser.on('text', (text: string) => {
      if (!skippingSmoothness) write(escapeText(text));
    });

    parser.on('closetag', (name: string) => {
      if (name === 'tag' && skippingSmoothness) {
        skippingSmoothness = false;
        return;
      }
      if (name === 'way' && inWay) {
        if (waySmoothness !== null) {
          write(`<tag k="smoothness" v="${escapeAttr(waySmoothness)}"/>`);
          waysTagged++;
        }
        inWay = false;
        waySmoothness = null;
      }
      write(`</${name}>`);
    });

    // Tear down the input→parser pipe on every terminal path — success, parse
    // error, or output error (e.g. ENOSPC). Without this a rejection would leave
    // the source still piped and reading on a large extract, wasting IO and
    // keeping the fd/listeners alive while BullMQ reschedules. Mirrors the
    // importer's `parseOsmXml` finally. `settle` is idempotent (destroy/unpipe
    // are safe to repeat), so whichever terminal event fires first wins.
    const settle = (finish: () => void): void => {
      input.unpipe(parser);
      input.destroy();
      finish();
    };
    parser.on('end', () => settle(() => resolve({ waysTagged })));
    parser.on('error', (err: Error) => settle(() => reject(err)));
    input.on('error', (err: Error) => settle(() => reject(err)));
    output.on('error', (err: Error) => settle(() => reject(err)));

    input.pipe(parser);
  });
}

/** Serialise sax attributes back to ` k="v"` pairs, escaped, in source order. */
function serializeAttrs(attrs: Record<string, string | undefined>): string {
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out += ` ${key}="${escapeAttr(value)}"`;
  }
  return out;
}

/** XML attribute-value escaping (adds `"` to the text set). */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** XML text escaping. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
