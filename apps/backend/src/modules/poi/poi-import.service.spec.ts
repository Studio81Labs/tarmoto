import { Repository } from 'typeorm';
import { PoiImportService } from './poi-import.service.js';
import { Poi } from '../../entities/poi.entity.js';
import type { PoiProvider, PointOfInterest } from './poi-provider.interface.js';
import type { PoiImportConfig } from './poi-import.config.js';

const CONFIG: PoiImportConfig = {
  enabled: true,
  bbox: { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
};

function poi(over: Partial<PointOfInterest> = {}): PointOfInterest {
  return {
    external_id: 'node/1',
    name: 'U Fleku',
    kind: 'restaurant',
    lat: 49.5,
    lng: 18.4,
    website: null,
    phone: null,
    hint: null,
    ...over,
  };
}

describe('PoiImportService', () => {
  let provider: { findPointsOfInterestInBbox: jest.Mock };
  let repo: { upsert: jest.Mock };
  let service: PoiImportService;

  beforeEach(() => {
    provider = { findPointsOfInterestInBbox: jest.fn().mockResolvedValue([]) };
    repo = { upsert: jest.fn().mockResolvedValue({}) };
    service = new PoiImportService(
      provider as unknown as PoiProvider,
      repo as unknown as Repository<Poi>,
      CONFIG,
    );
  });

  const upsertedRows = (): Record<string, unknown>[] => {
    const calls = repo.upsert.mock.calls as Record<string, unknown>[][][];
    return calls[0][0];
  };

  it('upserts fetched POIs by (source, external_id) with a Point geom', async () => {
    provider.findPointsOfInterestInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1' }),
      poi({ external_id: 'node/2', kind: 'cafe', lat: 49.6, lng: 18.5 }),
    ]);
    const result = await service.import();

    expect(provider.findPointsOfInterestInBbox).toHaveBeenCalledWith(
      CONFIG.bbox,
      expect.arrayContaining([
        'restaurant',
        'cafe',
        'viewpoint',
        'fuel_station',
      ]),
    );
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const upsertOptions = (
      repo.upsert.mock.calls as [unknown, unknown][]
    )[0][1];
    expect(upsertOptions).toEqual(
      expect.objectContaining({ conflictPaths: ['source', 'external_id'] }),
    );
    const rows = upsertedRows();
    expect(rows[0]).toEqual(
      expect.objectContaining({
        source: 'osm',
        external_id: 'node/1',
        kind: 'restaurant',
        geom: { type: 'Point', coordinates: [18.4, 49.5] },
      }),
    );
    expect(rows[0].last_imported_at).toBeInstanceOf(Date);
    expect(result).toEqual({ fetched: 2, upserted: 2 });
  });

  it('dedupes by external_id so a re-import is idempotent', async () => {
    provider.findPointsOfInterestInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1', name: 'Old' }),
      poi({ external_id: 'node/1', name: 'New' }), // same id, last wins
    ]);
    const result = await service.import();
    const rows = upsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('New');
    expect(result.upserted).toBe(1);
  });

  it('propagates a provider outage WITHOUT wiping existing rows', async () => {
    provider.findPointsOfInterestInBbox.mockRejectedValueOnce(
      new Error('Overpass API error: 504'),
    );
    await expect(service.import()).rejects.toThrow(/Overpass/);
    // No upsert means no write — the existing pois table is untouched.
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('does nothing (no upsert) when the area has no POIs', async () => {
    provider.findPointsOfInterestInBbox.mockResolvedValueOnce([]);
    const result = await service.import();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ fetched: 0, upserted: 0 });
  });
});
