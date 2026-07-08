import { Readable } from 'node:stream';
import {
  FsqPoiImportSource,
  OsmPoiImportSource,
  type StorableImportRow,
} from './poi-import-source.js';
import type { PoiImportRegion } from './poi-import.config.js';

const CZ: PoiImportRegion = {
  code: 'CZ',
  bbox: { minLng: 12, minLat: 48, maxLng: 19, maxLat: 51 },
};

function streamOf(text: string): Readable {
  return Readable.from([text]);
}

async function collect(
  gen: AsyncGenerator<StorableImportRow>,
): Promise<StorableImportRow[]> {
  const out: StorableImportRow[] = [];
  for await (const row of gen) out.push(row);
  return out;
}

function fsqLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    fsq_place_id: 'x',
    name: null,
    latitude: 49.9,
    longitude: 14.5,
    category_ids: null,
    category_labels: 'Restaurant',
    tel: null,
    website: null,
    address: null,
    locality: null,
    postcode: null,
    country: null,
    ...over,
  });
}

describe('FsqPoiImportSource', () => {
  const src = new FsqPoiImportSource();

  it('exposes the fsq source + <code>.fsq.jsonl filename', () => {
    expect(src.source).toBe('fsq');
    expect(src.extractFilename(CZ)).toBe('cz.fsq.jsonl');
  });

  it('streams NDJSON into normalized rows, dropping blanks + non-served kinds', async () => {
    const ndjson = [
      fsqLine({ fsq_place_id: 'a', category_labels: 'Restaurant' }),
      '', // blank line skipped
      fsqLine({ fsq_place_id: 'b', category_labels: 'Bank,ATM' }), // dropped
      fsqLine({ fsq_place_id: 'c', category_labels: 'Scenic Lookout' }),
    ].join('\n');

    const rows = await collect(src.parse(streamOf(ndjson)));
    expect(rows.map((r) => r.external_id)).toEqual(['fsq:a', 'fsq:c']);
    expect(rows.map((r) => r.kind)).toEqual(['restaurant', 'viewpoint']);
  });

  it('aborts on a malformed line (parse-before-write contract)', async () => {
    await expect(
      collect(src.parse(streamOf(`${fsqLine({})}\nnot json`))),
    ).rejects.toThrow();
  });
});

describe('OsmPoiImportSource', () => {
  it('exposes the osm source + <code>.osm filename', () => {
    const src = new OsmPoiImportSource();
    expect(src.source).toBe('osm');
    expect(src.extractFilename({ ...CZ, code: 'SK' })).toBe('sk.osm');
  });
});
