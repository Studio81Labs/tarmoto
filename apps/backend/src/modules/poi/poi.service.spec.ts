/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { PoiService } from './poi.service.js';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
} from './poi-provider.interface.js';

describe('PoiService', () => {
  let service: PoiService;
  let provider: jest.Mocked<PoiProvider>;

  const anchor = { lat: 49.1, lng: 16.75 };

  const buildPoi = (
    over: Partial<AccommodationPoi> = {},
  ): AccommodationPoi => ({
    external_id: 'osm:node:1',
    name: 'Hotel Alpha',
    kind: 'hotel',
    lat: anchor.lat + 0.01,
    lng: anchor.lng + 0.01,
    website: null,
    phone: null,
    stars: null,
    ...over,
  });

  beforeEach(async () => {
    provider = {
      findAccommodations: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PoiService, { provide: POI_PROVIDER, useValue: provider }],
    }).compile();

    service = module.get<PoiService>(PoiService);
  });

  describe('findAccommodationsNear', () => {
    it('uses the default radius when none is supplied', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
      );

      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
      );
      expect(result.radius_km).toBe(5);
      expect(result.accommodations).toEqual([]);
    });

    it('caps radius at 25 km', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        500,
      );

      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        25,
      );
      expect(result.radius_km).toBe(25);
    });

    it('falls back to default when radius is 0 or negative', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      await service.findAccommodationsNear(anchor.lat, anchor.lng, 0);
      await service.findAccommodationsNear(anchor.lat, anchor.lng, -3);

      const firstCallRadius = provider.findAccommodations.mock.calls[0][2];
      const secondCallRadius = provider.findAccommodations.mock.calls[1][2];
      expect(firstCallRadius).toBe(5);
      expect(secondCallRadius).toBe(5);
    });

    it('returns an empty list when the provider throws', async () => {
      provider.findAccommodations.mockRejectedValue(new Error('overpass down'));

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
      );

      expect(result.accommodations).toEqual([]);
      expect(result.radius_km).toBe(5);
    });

    it('returns normalized and distance-sorted results', async () => {
      provider.findAccommodations.mockResolvedValue([
        buildPoi({
          external_id: 'osm:node:1',
          name: 'Far Hotel',
          lat: anchor.lat + 0.05,
        }),
        buildPoi({
          external_id: 'osm:node:2',
          name: 'Close Hotel',
          lat: anchor.lat + 0.001,
        }),
      ]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
      );

      expect(result.accommodations).toHaveLength(2);
      expect(result.accommodations[0].name).toBe('Close Hotel');
      expect(result.accommodations[1].name).toBe('Far Hotel');
      expect(result.accommodations[0].distance_km).toBeLessThan(
        result.accommodations[1].distance_km,
      );
    });
  });

  describe('rank', () => {
    it('drops unnamed POIs with no website or phone', () => {
      const result = service.rank(
        [
          buildPoi({ external_id: 'osm:node:nameless', name: null }),
          buildPoi({ external_id: 'osm:node:named', name: 'Named Hotel' }),
        ],
        anchor.lat,
        anchor.lng,
      );

      expect(result.map((r) => r.external_id)).toEqual(['osm:node:named']);
    });

    it('keeps unnamed POIs if they have a contact channel, ranked after named ones', () => {
      const result = service.rank(
        [
          buildPoi({
            external_id: 'osm:node:phone',
            name: null,
            phone: '+420 555 000 111',
            lat: anchor.lat + 0.0005, // very close
          }),
          buildPoi({
            external_id: 'osm:node:named-far',
            name: 'Named But Far',
            lat: anchor.lat + 0.02,
          }),
        ],
        anchor.lat,
        anchor.lng,
      );

      expect(result.map((r) => r.external_id)).toEqual([
        'osm:node:named-far',
        'osm:node:phone',
      ]);
    });

    it('caps results at the configured maximum', () => {
      const many: AccommodationPoi[] = [];
      for (let i = 0; i < 20; i++) {
        many.push(
          buildPoi({
            external_id: `osm:node:${i}`,
            name: `Hotel ${i}`,
            lat: anchor.lat + i * 0.001,
          }),
        );
      }

      const result = service.rank(many, anchor.lat, anchor.lng);

      expect(result.length).toBeLessThanOrEqual(8);
      expect(result[0].name).toBe('Hotel 0'); // closest
    });

    it('rounds distance_km to one decimal place', () => {
      const result = service.rank(
        [
          buildPoi({
            external_id: 'osm:node:1',
            name: 'Hotel',
            lat: anchor.lat + 0.01234,
          }),
        ],
        anchor.lat,
        anchor.lng,
      );

      const distance = result[0].distance_km;
      expect(distance).toBeCloseTo(Math.round(distance * 10) / 10);
    });
  });
});
