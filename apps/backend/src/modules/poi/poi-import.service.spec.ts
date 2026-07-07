import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { PoiImportService } from './poi-import.service.js';
import { Poi } from '../../entities/poi.entity.js';
import type {
  AccommodationPoi,
  ImportedPoi,
  PoiProvider,
  StoredPoiFields,
} from './poi-provider.interface.js';
import type { PoiImportConfig } from './poi-import.config.js';

const CONFIG: PoiImportConfig = {
  enabled: true,
  bbox: { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 },
};

const NO_STORED_FIELDS: StoredPoiFields = {
  opening_hours: null,
  address_street: null,
  address_city: null,
  address_postcode: null,
  address_country: null,
  cuisine: null,
  brand: null,
  tags: null,
};

function poi(over: Partial<ImportedPoi> = {}): ImportedPoi {
  return {
    external_id: 'node/1',
    name: 'U Fleku',
    kind: 'restaurant',
    lat: 49.5,
    lng: 18.4,
    website: null,
    phone: null,
    ...NO_STORED_FIELDS,
    ...over,
  };
}

function accommodation(
  over: Partial<AccommodationPoi & StoredPoiFields> = {},
): AccommodationPoi & StoredPoiFields {
  return {
    external_id: 'way/10',
    name: 'Hotel Beskyd',
    kind: 'hotel',
    lat: 49.55,
    lng: 18.45,
    website: null,
    phone: null,
    stars: 3,
    ...NO_STORED_FIELDS,
    ...over,
  };
}

describe('PoiImportService', () => {
  let provider: {
    findImportPoisInBbox: jest.Mock;
    findAccommodationsInBbox: jest.Mock;
  };
  let repo: { upsert: jest.Mock };
  let service: PoiImportService;

  beforeEach(() => {
    provider = {
      findImportPoisInBbox: jest.fn().mockResolvedValue([]),
      findAccommodationsInBbox: jest.fn().mockResolvedValue([]),
    };
    repo = { upsert: jest.fn().mockResolvedValue({}) };
    service = new PoiImportService(
      provider as unknown as PoiProvider,
      {
        isInitialized: true,
        getRepository: () => repo as unknown as Repository<Poi>,
      } as unknown as DataSource,
      CONFIG,
    );
  });

  const upsertedRows = (): Record<string, unknown>[] => {
    const calls = repo.upsert.mock.calls as Record<string, unknown>[][][];
    return calls[0][0];
  };

  it('upserts fetched POIs by (source, external_id) with a Point geom', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1' }),
      poi({ external_id: 'node/2', kind: 'cafe', lat: 49.6, lng: 18.5 }),
    ]);
    const result = await service.import();

    expect(provider.findImportPoisInBbox).toHaveBeenCalledWith(CONFIG.bbox);
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

  it('imports accommodations alongside POIs so hotels/campsites are stored', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1' }),
    ]);
    provider.findAccommodationsInBbox.mockResolvedValueOnce([
      accommodation({ external_id: 'way/10', kind: 'hotel' }),
      accommodation({
        external_id: 'node/9',
        kind: 'camp_site',
        lat: 49.7,
        lng: 18.8,
      }),
    ]);

    const result = await service.import();

    expect(provider.findAccommodationsInBbox).toHaveBeenCalledWith(
      CONFIG.bbox,
      expect.arrayContaining(['hotel', 'camp_site', 'guest_house']),
    );
    const rows = upsertedRows();
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'way/10',
          kind: 'hotel',
          geom: { type: 'Point', coordinates: [18.45, 49.55] },
        }),
        expect.objectContaining({ external_id: 'node/9', kind: 'camp_site' }),
      ]),
    );
    expect(result).toEqual({ fetched: 3, upserted: 3 });
  });

  it('stores the extended §7 kinds (fast_food / rest_area / ice_cream)', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/3', kind: 'fast_food' }),
      poi({ external_id: 'way/4', kind: 'rest_area' }),
      poi({ external_id: 'node/5', kind: 'ice_cream' }),
    ]);
    await service.import();
    const kinds = upsertedRows().map((r) => r.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['fast_food', 'rest_area', 'ice_cream']),
    );
  });

  it('truncates over-long tags so a long phone never fails the upsert', async () => {
    const longPhone = Array(50).fill('+420 555 111 222').join('; '); // > 255
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1', phone: longPhone }),
    ]);
    await service.import();
    const phone = upsertedRows()[0].phone as string;
    expect(phone.length).toBe(255);
    expect(longPhone.startsWith(phone)).toBe(true);
  });

  it('persists decision-support fields (hours/address/cuisine/tags)', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({
        external_id: 'node/1',
        opening_hours: 'Mo-Su 08:00-20:00',
        address_street: 'Náměstí 1',
        address_city: 'Brno',
        address_postcode: '60200',
        address_country: 'CZ',
        cuisine: 'czech',
        tags: { amenity: 'restaurant', cuisine: 'czech' },
      }),
    ]);
    await service.import();
    expect(upsertedRows()[0]).toEqual(
      expect.objectContaining({
        opening_hours: 'Mo-Su 08:00-20:00',
        address_street: 'Náměstí 1',
        address_city: 'Brno',
        address_postcode: '60200',
        address_country: 'CZ',
        cuisine: 'czech',
        tags: { amenity: 'restaurant', cuisine: 'czech' },
      }),
    );
  });

  it('persists accommodation stars and address into the store', async () => {
    provider.findAccommodationsInBbox.mockResolvedValueOnce([
      accommodation({
        external_id: 'way/10',
        stars: 4,
        address_city: 'Ostrava',
      }),
    ]);
    await service.import();
    expect(upsertedRows()[0]).toEqual(
      expect.objectContaining({
        external_id: 'way/10',
        stars: 4,
        address_city: 'Ostrava',
      }),
    );
  });

  it('clamps an over-long opening_hours to the column width', async () => {
    const longHours = 'Mo-Su 00:00-24:00; '.repeat(50); // > 512
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1', opening_hours: longHours }),
    ]);
    await service.import();
    const oh = upsertedRows()[0].opening_hours as string;
    expect(oh.length).toBe(512);
    expect(longHours.startsWith(oh)).toBe(true);
  });

  it('dedupes by external_id so a re-import is idempotent', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
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
    provider.findImportPoisInBbox.mockRejectedValueOnce(
      new Error('Overpass API error: 504'),
    );
    await expect(service.import()).rejects.toThrow(/Overpass/);
    // No upsert means no write — the existing pois table is untouched.
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('does nothing (no upsert) when the area has no POIs', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([]);
    const result = await service.import();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ fetched: 0, upserted: 0 });
  });

  it('throws 503 from import() when the POI DataSource is not initialized', async () => {
    const service = new PoiImportService(
      provider as unknown as PoiProvider,
      { isInitialized: false } as DataSource,
      CONFIG,
    );
    await expect(service.import()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 503 (not the raw driver error) from import() when upsert fails with a connection error (runtime POI-DB drop)', async () => {
    provider.findImportPoisInBbox.mockResolvedValueOnce([
      poi({ external_id: 'node/1' }),
    ]);
    repo.upsert.mockRejectedValueOnce(
      Object.assign(new Error('Connection terminated unexpectedly'), {
        code: '08006',
      }),
    );
    await expect(service.import()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
