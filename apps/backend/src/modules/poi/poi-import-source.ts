import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { PoiImportRegion } from './poi-import.config.js';
import type { StoredPoiFields } from './poi-provider.interface.js';
import { parsePoiExtract } from './poi-extract-source.js';
import { fsqRowToImportRow, type FsqPlaceRow } from './fsq-poi-categories.js';

/**
 * The normalized row every bulk source yields — the common denominator of the
 * OSM `ImportedPoi` / `AccommodationPoi` shapes and (later) the Foursquare
 * rows. `stars` is optional (only accommodations carry it); the rest of the
 * decision-support columns come in via `Partial<StoredPoiFields>`.
 */
export type StorableImportRow = {
  external_id: string;
  kind: string;
  name: string | null;
  website: string | null;
  phone: string | null;
  lat: number;
  lng: number;
  stars?: number | null;
} & Partial<StoredPoiFields>;

/**
 * A bulk POI import source (#850 OSM/Geofabrik, #869 Foursquare OS Places).
 * Isolates the only three things that differ per source — the provenance string
 * written to `pois.source`, the per-region extract filename, and how the
 * extract stream is parsed into normalized rows. Everything else (bbox filter,
 * dedupe, the upsert + bbox-bounded tombstone transaction, the safety guards)
 * lives in {@link PoiImportService} and is source-neutral.
 */
export interface PoiImportSource {
  /** Provenance written to `pois.source`; also scopes the tombstone pass so a
   *  run for one source never touches another's rows. */
  readonly source: string;
  /** The extract filename for a region under the configured `extractDir`
   *  (e.g. `cz.osm`, `cz.fsq.parquet`). */
  extractFilename(region: PoiImportRegion): string;
  /** Stream the (already region-filtered) extract into normalized rows. */
  parse(stream: Readable): AsyncGenerator<StorableImportRow>;
}

/** DI token for the optional per-instance source strategy (defaults to OSM). */
export const POI_IMPORT_SOURCE = Symbol('POI_IMPORT_SOURCE');

/**
 * The OSM/Geofabrik source (#850): per-country `.osm` extracts streamed through
 * the sax reader, unwrapped to the flat POI / accommodation row.
 */
export class OsmPoiImportSource implements PoiImportSource {
  readonly source = 'osm';

  extractFilename(region: PoiImportRegion): string {
    return `${region.code.toLowerCase()}.osm`;
  }

  async *parse(stream: Readable): AsyncGenerator<StorableImportRow> {
    for await (const item of parsePoiExtract(stream)) {
      yield 'poi' in item ? item.poi : item.accommodation;
    }
  }
}

/**
 * The Foursquare OS Places source (#869). The operator's offline DuckDB recipe
 * (see the runbook) filters the monthly OS Places dump to a region's bbox + our
 * categories and writes newline-delimited JSON (`<code>.fsq.jsonl`) — small and
 * scalar, so the backend streams it line-by-line with no Parquet dependency.
 * Each line is one {@link FsqPlaceRow}; non-category / invalid rows are dropped.
 * A malformed line throws, aborting the import before any write — the same
 * outage-safety contract as the OSM parser.
 */
export class FsqPoiImportSource implements PoiImportSource {
  readonly source = 'fsq';

  extractFilename(region: PoiImportRegion): string {
    return `${region.code.toLowerCase()}.fsq.jsonl`;
  }

  async *parse(stream: Readable): AsyncGenerator<StorableImportRow> {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = fsqRowToImportRow(JSON.parse(trimmed) as FsqPlaceRow);
      if (row) yield row;
    }
  }
}
