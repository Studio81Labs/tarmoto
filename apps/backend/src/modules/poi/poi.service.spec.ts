/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { PoiService } from './poi.service.js';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
  type PointOfInterest,
} from './poi-provider.interface.js';
import type { PoiKind } from './dto/point-of-interest.dto.js';
import type { AccommodationKind } from './dto/accommodation.dto.js';

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

  const buildNearbyPoi = (
    over: Partial<PointOfInterest> = {},
  ): PointOfInterest => ({
    external_id: 'osm:node:1',
    name: 'Placeholder',
    kind: 'restaurant',
    lat: anchor.lat + 0.01,
    lng: anchor.lng + 0.01,
    website: null,
    phone: null,
    hint: null,
    ...over,
  });

  beforeEach(async () => {
    provider = {
      findAccommodations: jest.fn(),
      findPointsOfInterest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PoiService, { provide: POI_PROVIDER, useValue: provider }],
    }).compile();

    service = module.get<PoiService>(PoiService);
  });

  describe('findAccommodationsNear', () => {
    it('uses the default radius + all kinds when none are supplied', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
      );

      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        expect.arrayContaining<AccommodationKind>([
          'hotel',
          'motel',
          'hostel',
          'guest_house',
          'apartment',
          'chalet',
          'camp_site',
        ]),
      );
      expect(result.radius_km).toBe(5);
      expect(result.accommodations).toEqual([]);
      expect(result.kinds).toEqual(
        expect.arrayContaining<AccommodationKind>([
          'hotel',
          'motel',
          'hostel',
          'guest_house',
          'apartment',
          'chalet',
          'camp_site',
        ]),
      );
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
        expect.any(Array),
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

    it('forwards an explicit kinds filter to the provider', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        7,
        ['hotel', 'camp_site'],
      );

      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        7,
        ['hotel', 'camp_site'],
      );
      expect(result.kinds).toEqual(['hotel', 'camp_site']);
    });

    it('deduplicates repeated kinds before hitting the provider', async () => {
      provider.findAccommodations.mockResolvedValue([]);

      await service.findAccommodationsNear(anchor.lat, anchor.lng, undefined, [
        'hotel',
        'hotel',
        'motel',
      ]);

      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        ['hotel', 'motel'],
      );
    });

    it('filters provider results by min_stars and drops unrated entries', async () => {
      // Ratings range across "null" (no tag), 2, 4, 5. Rider asks for
      // ≥ 4 — the unrated entry must be dropped rather than optimistically
      // kept, otherwise "3★-and-up" silently includes the long tail of
      // untagged rows and the filter is meaningless.
      provider.findAccommodations.mockResolvedValue([
        buildPoi({
          external_id: 'osm:node:unrated',
          name: 'Unrated',
          stars: null,
        }),
        buildPoi({ external_id: 'osm:node:2star', name: '2-star', stars: 2 }),
        buildPoi({ external_id: 'osm:node:4star', name: '4-star', stars: 4 }),
        buildPoi({ external_id: 'osm:node:5star', name: '5-star', stars: 5 }),
      ]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        undefined,
        undefined,
        4,
      );

      expect(result.accommodations.map((a) => a.external_id).sort()).toEqual([
        'osm:node:4star',
        'osm:node:5star',
      ]);
    });

    it('filters out kinds the provider returned that the rider did not request', async () => {
      // Belt-and-suspenders: even if a provider ignores the kinds filter
      // (a stubbed provider, a misbehaving one), the service still drops
      // off-kind rows so the contract with the client stays "you only
      // get what you asked for".
      provider.findAccommodations.mockResolvedValue([
        buildPoi({
          external_id: 'osm:node:hotel',
          kind: 'hotel',
          name: 'Hotel',
        }),
        buildPoi({
          external_id: 'osm:node:camp',
          kind: 'camp_site',
          name: 'Camp',
        }),
      ]);

      const result = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        undefined,
        ['hotel'],
      );

      expect(result.accommodations.map((a) => a.external_id)).toEqual([
        'osm:node:hotel',
      ]);
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

  describe('findPointsOfInterestNear', () => {
    it('defaults radius + kinds when neither is supplied', async () => {
      provider.findPointsOfInterest.mockResolvedValue([]);

      const result = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
      );

      expect(provider.findPointsOfInterest).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        expect.arrayContaining<PoiKind>([
          'restaurant',
          'viewpoint',
          'cafe',
          'fuel_station',
        ]),
      );
      expect(result.radius_km).toBe(5);
      expect(result.kinds).toEqual(
        expect.arrayContaining<PoiKind>([
          'restaurant',
          'viewpoint',
          'cafe',
          'fuel_station',
        ]),
      );
      expect(result.pois).toEqual([]);
    });

    it('respects an explicit kinds filter', async () => {
      provider.findPointsOfInterest.mockResolvedValue([]);

      await service.findPointsOfInterestNear(anchor.lat, anchor.lng, 7, [
        'viewpoint',
      ]);

      expect(provider.findPointsOfInterest).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        7,
        ['viewpoint'],
      );
    });

    it('caps radius at 25 km', async () => {
      provider.findPointsOfInterest.mockResolvedValue([]);

      const result = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        500,
      );

      expect(provider.findPointsOfInterest).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        25,
        expect.any(Array),
      );
      expect(result.radius_km).toBe(25);
    });

    it('returns an empty list when the provider throws', async () => {
      provider.findPointsOfInterest.mockRejectedValue(
        new Error('overpass down'),
      );

      const result = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
      );

      expect(result.pois).toEqual([]);
      expect(result.radius_km).toBe(5);
    });

    it('drops kinds that were not requested', async () => {
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({
          external_id: 'osm:node:rest',
          kind: 'restaurant',
          name: 'Trattoria',
        }),
        buildNearbyPoi({
          external_id: 'osm:node:view',
          kind: 'viewpoint',
          name: 'Cliff top',
        }),
      ]);

      const result = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
        ['viewpoint'],
      );

      expect(result.pois.map((p) => p.external_id)).toEqual(['osm:node:view']);
    });
  });

  describe('rankPois', () => {
    const allKinds: PoiKind[] = [
      'restaurant',
      'viewpoint',
      'cafe',
      'fuel_station',
    ];

    it('drops unnamed POIs with no website or phone', () => {
      const result = service.rankPois(
        [
          buildNearbyPoi({ external_id: 'osm:node:nameless', name: null }),
          buildNearbyPoi({
            external_id: 'osm:node:named',
            name: 'Named restaurant',
          }),
        ],
        anchor.lat,
        anchor.lng,
        allKinds,
      );

      expect(result.map((r) => r.external_id)).toEqual(['osm:node:named']);
    });

    it('keeps unnamed POIs if they have a contact channel', () => {
      const result = service.rankPois(
        [
          buildNearbyPoi({
            external_id: 'osm:node:phone',
            name: null,
            phone: '+420 555 000 111',
          }),
        ],
        anchor.lat,
        anchor.lng,
        allKinds,
      );

      expect(result.map((r) => r.external_id)).toEqual(['osm:node:phone']);
    });

    it('caps results per-kind so one kind cannot squeeze out others', () => {
      const many: PointOfInterest[] = [];
      // Ten restaurants (well above the per-kind cap of 6) …
      for (let i = 0; i < 10; i++) {
        many.push(
          buildNearbyPoi({
            external_id: `osm:node:r${i}`,
            kind: 'restaurant',
            name: `Restaurant ${i}`,
            lat: anchor.lat + i * 0.0001,
          }),
        );
      }
      // … and one far-away viewpoint.
      many.push(
        buildNearbyPoi({
          external_id: 'osm:node:view',
          kind: 'viewpoint',
          name: 'Far viewpoint',
          lat: anchor.lat + 0.02,
        }),
      );

      const result = service.rankPois(many, anchor.lat, anchor.lng, allKinds);

      const restaurants = result.filter((p) => p.kind === 'restaurant');
      const viewpoints = result.filter((p) => p.kind === 'viewpoint');
      expect(restaurants.length).toBeLessThanOrEqual(6);
      expect(viewpoints.map((v) => v.external_id)).toEqual(['osm:node:view']);
    });

    it('final order is closest-first across kinds', () => {
      const result = service.rankPois(
        [
          buildNearbyPoi({
            external_id: 'osm:node:far',
            kind: 'restaurant',
            name: 'Far',
            lat: anchor.lat + 0.05,
          }),
          buildNearbyPoi({
            external_id: 'osm:node:close',
            kind: 'viewpoint',
            name: 'Close',
            lat: anchor.lat + 0.001,
          }),
        ],
        anchor.lat,
        anchor.lng,
        allKinds,
      );

      expect(result[0].external_id).toBe('osm:node:close');
      expect(result[0].distance_km).toBeLessThan(result[1].distance_km);
    });

    it('keeps fuel stations in the ranked output alongside other kinds', () => {
      // US-36: fuel stations must flow through the same ranker as the
      // other kinds so they show up on the "Places near day end" card
      // next to restaurants and viewpoints. A regression here — e.g. a
      // missing entry in `POI_KIND_TAGS` — would silently drop them
      // from the response even when the provider returns them.
      const result = service.rankPois(
        [
          buildNearbyPoi({
            external_id: 'osm:node:fuel',
            kind: 'fuel_station',
            name: 'Shell',
            lat: anchor.lat + 0.002,
          }),
          buildNearbyPoi({
            external_id: 'osm:node:rest',
            kind: 'restaurant',
            name: 'Trattoria',
            lat: anchor.lat + 0.005,
          }),
        ],
        anchor.lat,
        anchor.lng,
        allKinds,
      );

      const kinds = result.map((r) => r.kind);
      expect(kinds).toContain('fuel_station');
      expect(kinds).toContain('restaurant');
    });
  });
});
