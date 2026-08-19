import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  cumulativeLengthKm,
  PoiService,
  projectOntoRoute,
  sampleRouteAnchors,
} from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import {
  POI_PROVIDER,
  type PoiProvider,
  type AccommodationPoi,
  type PointOfInterest,
  type StoredPoiFields,
} from './poi-provider.interface.js';
import type { PoiKind, AccommodationKind } from '@tarmoto/shared';

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

describe('PoiService', () => {
  let service: PoiService;
  let provider: jest.Mocked<PoiProvider>;
  let store: {
    findPointsOfInterestNear: jest.Mock;
    findAccommodationsNear: jest.Mock;
    findPointsOfInterestInCorridor: jest.Mock;
    isRequestCovered: jest.Mock;
  };

  // Coverage is now region-polygon membership (#944): `isRequestCovered`
  // resolves true when the request geometry sits entirely within an
  // OSM-imported region. A test that wants the store treated as authoritative
  // (imported territory) sets it true; the default is false (un-imported), so
  // store-empty reads fall through to Overpass exactly as the pre-#925
  // store-first path did.
  const COVERED = true;

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
    ...NO_STORED_FIELDS,
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
    ...NO_STORED_FIELDS,
    ...over,
  });

  beforeEach(async () => {
    provider = {
      findAccommodations: jest.fn(),
      findPointsOfInterest: jest.fn(),
      findPointsOfInterestAroundPoints: jest.fn(),
    };
    // Store-first (#849): default every store read to empty so the existing
    // provider-focused tests exercise the Overpass fallback path unchanged.
    store = {
      findPointsOfInterestNear: jest.fn().mockResolvedValue([]),
      findAccommodationsNear: jest.fn().mockResolvedValue([]),
      findPointsOfInterestInCorridor: jest.fn().mockResolvedValue([]),
      // Default: request geometry NOT covered by any imported region. An empty
      // store then merges with Overpass (= Overpass), matching the pre-#925
      // fallback; tests that want the store treated as authoritative override
      // this with COVERED.
      isRequestCovered: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PoiService,
        { provide: POI_PROVIDER, useValue: provider },
        { provide: PoiStoreService, useValue: store },
      ],
    }).compile();

    service = module.get<PoiService>(PoiService);
  });

  describe('store-first with Overpass fallback (#849)', () => {
    const route = [
      { lat: 49.0, lng: 16.75 },
      { lat: 50.0, lng: 16.75 },
    ];

    it('serves nearby POIs from the store and never calls the provider when the store has rows', async () => {
      store.isRequestCovered.mockResolvedValue(COVERED); // imported area
      store.findPointsOfInterestNear.mockResolvedValue([
        buildNearbyPoi({
          external_id: 'store:1',
          name: 'Stored café',
          kind: 'cafe',
        }),
      ]);
      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );
      expect(store.findPointsOfInterestNear).toHaveBeenCalled();
      expect(provider.findPointsOfInterest).not.toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toEqual(['store:1']);
    });

    it('falls back to Overpass for nearby POIs when the store is empty (un-imported region)', async () => {
      store.findPointsOfInterestNear.mockResolvedValue([]);
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({
          external_id: 'live:1',
          name: 'Live café',
          kind: 'cafe',
        }),
      ]);
      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );
      expect(provider.findPointsOfInterest).toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toEqual(['live:1']);
    });

    it('falls back to Overpass when the store read throws (DB down), not to an empty list', async () => {
      store.findPointsOfInterestNear.mockRejectedValue(
        new ServiceUnavailableException('POI store is temporarily unavailable'),
      );
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({ external_id: 'live:1' }),
      ]);
      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );
      expect(provider.findPointsOfInterest).toHaveBeenCalled();
      expect(res.pois).toHaveLength(1);
    });

    it('returns an empty list (never 500) when both the store outage and the provider fail', async () => {
      store.findPointsOfInterestNear.mockRejectedValue(
        new ServiceUnavailableException('store down'),
      );
      provider.findPointsOfInterest.mockRejectedValue(
        new Error('overpass down'),
      );
      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );
      expect(res.pois).toEqual([]);
    });

    it('surfaces a non-connection store error (real bug) instead of masking it behind Overpass', async () => {
      // withPoiRepo rethrows non-connection errors (e.g. a missed migration)
      // as-is; they must surface, not silently fall back to the live provider.
      store.findPointsOfInterestNear.mockRejectedValue(
        new Error('column "stars" does not exist'),
      );
      await expect(
        service.findPointsOfInterestNear(anchor.lat, anchor.lng, 5),
      ).rejects.toThrow('column "stars" does not exist');
      expect(provider.findPointsOfInterest).not.toHaveBeenCalled();
    });

    it('serves accommodations from the store when present', async () => {
      store.isRequestCovered.mockResolvedValue(COVERED); // imported area
      store.findAccommodationsNear.mockResolvedValue([
        buildPoi({ external_id: 'store:h1', stars: 4 }),
      ]);
      const res = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        10,
      );
      expect(provider.findAccommodations).not.toHaveBeenCalled();
      expect(res.accommodations.map((a) => a.external_id)).toEqual([
        'store:h1',
      ]);
    });

    it('serves along-route POIs from the store corridor without sampling Overpass anchors', async () => {
      store.isRequestCovered.mockResolvedValue(COVERED); // imported area
      store.findPointsOfInterestInCorridor.mockResolvedValue([
        buildNearbyPoi({ external_id: 'store:r1', lat: 49.0, lng: 16.75 }),
      ]);
      const res = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });
      expect(store.findPointsOfInterestInCorridor).toHaveBeenCalled();
      expect(provider.findPointsOfInterestAroundPoints).not.toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toContain('store:r1');
    });

    it('falls back to Overpass anchor sampling for along-route when the store corridor is empty', async () => {
      store.findPointsOfInterestInCorridor.mockResolvedValue([]);
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        buildNearbyPoi({ external_id: 'live:r1', lat: 49.0, lng: 16.75 }),
      ]);
      const res = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });
      expect(provider.findPointsOfInterestAroundPoints).toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toContain('live:r1');
    });
  });

  describe('coverage-aware fallback at the import frontier (#925)', () => {
    it('trusts the store (no Overpass) when an imported point is near the request', async () => {
      store.isRequestCovered.mockResolvedValue(true); // inside imported territory
      store.findPointsOfInterestNear.mockResolvedValue([
        buildNearbyPoi({ external_id: 'store:1', kind: 'cafe' }),
      ]);

      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );

      expect(provider.findPointsOfInterest).not.toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toEqual(['store:1']);
    });

    it('merges Overpass at a frontier and boosts the provider cap by the store row count so the uncovered side is not starved (#945)', async () => {
      store.isRequestCovered.mockResolvedValue(false); // no import near → not covered
      store.findPointsOfInterestNear.mockResolvedValue([
        buildNearbyPoi({ external_id: 'osm:node:c1', kind: 'cafe' }),
        buildNearbyPoi({ external_id: 'osm:node:c2', kind: 'cafe' }),
      ]);
      provider.findPointsOfInterest.mockResolvedValue([
        // Overpass covers the whole area, so it re-returns the covered POIs (must
        // de-dup, store wins) plus the uncovered-side one.
        buildNearbyPoi({ external_id: 'osm:node:c1', kind: 'cafe' }),
        buildNearbyPoi({ external_id: 'osm:node:c2', kind: 'cafe' }),
        buildNearbyPoi({ external_id: 'osm:node:uncovered', kind: 'cafe' }),
      ]);

      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );

      // #945: on the merge path the provider cap is boosted by the store row
      // count (2), so the covered-side duplicates can't fill the cap and starve
      // the uncovered side.
      expect(provider.findPointsOfInterest).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        expect.any(Array),
        2,
      );
      expect(res.pois.map((p) => p.external_id).sort()).toEqual([
        'osm:node:c1',
        'osm:node:c2',
        'osm:node:uncovered',
      ]);
    });

    it('accommodations: boosts by the UNFILTERED covered count, not the min_stars-filtered store rows (#945 Codex P2)', async () => {
      // At a dense frontier city full of unrated hotels the store read pushes
      // `min_stars` into SQL, so `stored` holds only the rated few — but the live
      // Overpass query is star-unfiltered, so its covered-side rows (rated AND
      // unrated) fill the cap. Boosting by the rated count (1) would still starve
      // the uncovered side; the boost must use the unfiltered count (5).
      store.isRequestCovered.mockResolvedValue(false); // frontier → merge
      store.findAccommodationsNear.mockImplementation(
        (_lat, _lng, _radius, _kinds, minStars) =>
          Promise.resolve(
            minStars !== undefined
              ? // filtered result: only the rated covered-side stay
                [buildPoi({ external_id: 'osm:node:rated', stars: 4 })]
              : // unfiltered covered-side count for the boost: 1 rated + 4 unrated
                [
                  buildPoi({ external_id: 'osm:node:rated', stars: 4 }),
                  buildPoi({ external_id: 'osm:node:u1', stars: null }),
                  buildPoi({ external_id: 'osm:node:u2', stars: null }),
                  buildPoi({ external_id: 'osm:node:u3', stars: null }),
                  buildPoi({ external_id: 'osm:node:u4', stars: null }),
                ],
          ),
      );
      provider.findAccommodations.mockResolvedValue([
        buildPoi({ external_id: 'osm:node:rated', stars: 4 }), // covered dup
        buildPoi({ external_id: 'osm:node:uncovered', stars: 5 }), // uncovered rated
      ]);

      const res = await service.findAccommodationsNear(
        anchor.lat,
        anchor.lng,
        5,
        undefined,
        4, // min_stars
      );

      // Boost = 5 (unfiltered covered count), NOT 1 (the star-filtered store rows).
      expect(provider.findAccommodations).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        expect.any(Array),
        5,
      );
      // The boost is a second store read WITHOUT the min_stars arg (4 args).
      expect(store.findAccommodationsNear).toHaveBeenCalledWith(
        anchor.lat,
        anchor.lng,
        5,
        expect.any(Array),
      );
      expect(res.accommodations.map((a) => a.external_id).sort()).toEqual([
        'osm:node:rated',
        'osm:node:uncovered',
      ]);
    });

    it('falls back entirely to Overpass when no import is near (un-imported gap / border wedge)', async () => {
      store.isRequestCovered.mockResolvedValue(false);
      store.findPointsOfInterestNear.mockResolvedValue([]); // nothing imported here
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({ external_id: 'live:1', kind: 'cafe' }),
      ]);

      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );

      expect(provider.findPointsOfInterest).toHaveBeenCalled();
      expect(res.pois.map((p) => p.external_id)).toEqual(['live:1']);
    });

    it('treats a covered but EMPTY store result as authoritative — no Overpass (#925 review)', async () => {
      // A sparse or kind-/min_stars-filtered lookup inside imported territory is
      // genuinely empty, not un-imported, so it must not keep hitting Overpass.
      store.isRequestCovered.mockResolvedValue(true);
      store.findPointsOfInterestNear.mockResolvedValue([]);

      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );

      expect(provider.findPointsOfInterest).not.toHaveBeenCalled();
      expect(res.pois).toEqual([]);
    });

    it('degrades to an Overpass merge (no 500) when the coverage lookup itself has an outage (#925 review)', async () => {
      store.findPointsOfInterestNear.mockResolvedValue([
        buildNearbyPoi({ external_id: 'store:1', kind: 'cafe' }),
      ]);
      // The store drops between fromStore() and the coverage query.
      store.isRequestCovered.mockRejectedValue(
        new ServiceUnavailableException('POI store is temporarily unavailable'),
      );
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({ external_id: 'live:1', kind: 'cafe' }),
      ]);

      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
        5,
      );

      // Coverage unknown → treated as un-covered → store rows merged with
      // Overpass rather than a 500.
      expect(res.pois.map((p) => p.external_id).sort()).toEqual([
        'live:1',
        'store:1',
      ]);
    });
  });

  describe('decision-support field mapping (#849)', () => {
    it('surfaces hours/address/cuisine + osm_url on nearby POIs', async () => {
      provider.findPointsOfInterest.mockResolvedValue([
        buildNearbyPoi({
          external_id: 'osm:node:42',
          name: 'Koliba',
          opening_hours: 'Mo-Su 11:00-22:00',
          address_city: 'Brno',
          cuisine: 'regional',
        }),
      ]);
      const res = await service.findPointsOfInterestNear(
        anchor.lat,
        anchor.lng,
      );
      expect(res.pois[0]).toEqual(
        expect.objectContaining({
          opening_hours: 'Mo-Su 11:00-22:00',
          address_city: 'Brno',
          cuisine: 'regional',
          osm_url: 'https://www.openstreetmap.org/node/42',
        }),
      );
      expect(res.pois[0]?.maps_url).toContain(
        'www.google.com/maps/search/?api=1&query=Koliba',
      );
    });

    it('surfaces hours/address + osm_url on accommodations', async () => {
      provider.findAccommodations.mockResolvedValue([
        buildPoi({
          external_id: 'osm:way:99',
          name: 'Hotel Beskyd',
          opening_hours: '24/7',
          address_city: 'Ostrava',
        }),
      ]);
      const res = await service.findAccommodationsNear(anchor.lat, anchor.lng);
      expect(res.accommodations[0]).toEqual(
        expect.objectContaining({
          opening_hours: '24/7',
          address_city: 'Ostrava',
          osm_url: 'https://www.openstreetmap.org/way/99',
        }),
      );
    });

    it('surfaces brand/address + osm_url on along-route POIs', async () => {
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        buildNearbyPoi({
          external_id: 'osm:node:7',
          name: 'Shell',
          kind: 'fuel_station',
          brand: 'Shell',
          address_city: 'Zlín',
        }),
      ]);
      const res = await service.findPointsOfInterestAlongRoute({
        route: [
          { lat: anchor.lat, lng: anchor.lng },
          { lat: anchor.lat + 0.02, lng: anchor.lng + 0.02 },
        ],
        buffer_km: 5,
      });
      expect(res.pois[0]).toEqual(
        expect.objectContaining({
          brand: 'Shell',
          address_city: 'Zlín',
          osm_url: 'https://www.openstreetmap.org/node/7',
        }),
      );
    });
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
        0,
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
        0,
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
        0,
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
        0,
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
    it('keeps unnamed POIs — maps_url makes them navigable — ranked after named ones', () => {
      const result = service.rank(
        [
          // Nameless AND no contact, but closer than the named one: it is
          // still kept (a maps_url deep link makes it navigable) and the
          // named-first sort ranks it last regardless of proximity.
          buildPoi({
            external_id: 'osm:node:nameless',
            name: null,
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
        'osm:node:nameless',
      ]);
    });

    it('keeps a lone nameless POI with no website or phone', () => {
      const result = service.rank(
        [buildPoi({ external_id: 'osm:node:nameless', name: null })],
        anchor.lat,
        anchor.lng,
      );

      expect(result.map((r) => r.external_id)).toEqual(['osm:node:nameless']);
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

    it('cross-source de-dupes and ranks by the closest copy (#869)', () => {
      // FSQ copy 0.14 km from the anchor, its preferred OSM twin 0.16 km, ~20 m
      // apart (same kind + name). De-dup keeps the OSM row but must rank it at
      // the FSQ copy's closer distance, so a farther OSM twin can't fall outside
      // the display cap. The distances straddle a rounding boundary (0.14 → 0.1,
      // 0.16 → 0.2), so the carried value is observable.
      const result = service.rank(
        [
          buildPoi({
            external_id: 'osm:hotel',
            name: 'Grand',
            kind: 'hotel',
            lat: 49.1014389, // 0.16 km from the anchor → rounds to 0.2
            lng: 16.75,
          }),
          buildPoi({
            external_id: 'fsq:hotel',
            name: 'Grand',
            kind: 'hotel',
            lat: 49.101259, // 0.14 km → rounds to 0.1, ~20 m from OSM
            lng: 16.75,
          }),
        ],
        anchor.lat,
        anchor.lng,
      );
      expect(result.map((r) => r.external_id)).toEqual(['osm:hotel']);
      expect(result[0].distance_km).toBe(0.1); // FSQ's 0.14, not OSM's 0.16 → 0.2
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
        0,
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
        0,
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
        0,
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

    it('keeps unnamed POIs alongside named ones — maps_url makes them navigable', () => {
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

      // Both survive (the nameless row now carries a maps_url deep link). The
      // final list is distance-sorted, so assert membership, not order.
      expect(result.map((r) => r.external_id).sort()).toEqual([
        'osm:node:named',
        'osm:node:nameless',
      ]);
    });

    it('keeps a lone nameless POI with no website or phone', () => {
      const result = service.rankPois(
        [buildNearbyPoi({ external_id: 'osm:node:nameless', name: null })],
        anchor.lat,
        anchor.lng,
        allKinds,
      );

      expect(result.map((r) => r.external_id)).toEqual(['osm:node:nameless']);
    });

    it('cross-source de-dupes and ranks by the closest copy (#869)', () => {
      // FSQ copy 0.14 km from the anchor, its preferred OSM twin 0.16 km, ~20 m
      // apart (same kind + name). De-dup keeps the OSM row but must rank it at
      // the FSQ copy's closer distance, so a farther OSM twin can't sort past the
      // per-kind cap and drop the venue. The distances straddle a rounding
      // boundary (0.14 → 0.1, 0.16 → 0.2), so the carried value is observable.
      const result = service.rankPois(
        [
          buildNearbyPoi({
            external_id: 'osm:koliba',
            name: 'Koliba',
            kind: 'restaurant',
            lat: 49.1014389, // 0.16 km from the anchor → rounds to 0.2
            lng: 16.75,
          }),
          buildNearbyPoi({
            external_id: 'fsq:koliba',
            name: 'Koliba',
            kind: 'restaurant',
            lat: 49.101259, // 0.14 km → rounds to 0.1, ~20 m from OSM
            lng: 16.75,
          }),
        ],
        anchor.lat,
        anchor.lng,
        allKinds,
      );
      expect(result.map((r) => r.external_id)).toEqual(['osm:koliba']);
      expect(result[0].distance_km).toBe(0.1); // FSQ's 0.14, not OSM's 0.16 → 0.2
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

  describe('findPointsOfInterestAlongRoute', () => {
    // A ~222 km south-to-north strip of vertices; lat-only movement so
    // haversine stays ~111 km per degree. Two degrees of latitude
    // across five vertices ⇒ ~222 km total.
    const route = [
      { lat: 49.0, lng: 16.75 },
      { lat: 49.5, lng: 16.75 },
      { lat: 50.0, lng: 16.75 },
      { lat: 50.5, lng: 16.75 },
      { lat: 51.0, lng: 16.75 },
    ];

    it('rejects a degenerate route with < 2 vertices', async () => {
      await expect(
        service.findPointsOfInterestAlongRoute({
          route: [route[0]],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns an empty list when the provider throws', async () => {
      provider.findPointsOfInterestAroundPoints.mockRejectedValue(
        new Error('overpass down'),
      );

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 3,
      });

      expect(result.pois).toEqual([]);
      expect(result.buffer_km).toBe(3);
      // 2° of lat ≈ 222 km — just a sanity check that `route_length_km`
      // is populated from the polyline even on a provider failure.
      expect(result.route_length_km).toBeGreaterThan(220);
      expect(result.route_length_km).toBeLessThan(224);
    });

    it('clamps buffer_km into [0.5, 20] with a sensible default', async () => {
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([]);

      const zero = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 0,
      });
      expect(zero.buffer_km).toBe(2);

      const huge = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 999,
      });
      expect(huge.buffer_km).toBe(20);
    });

    it('drops POIs outside the buffer after the provider returns them', async () => {
      // One station right on the route, one station ~55 km off to the
      // east (0.5° lng at lat 50 ≈ 35.7 km — still well outside a 2 km
      // buffer). The first survives, the second gets filtered out.
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:on-route',
          name: 'Shell Brno',
          kind: 'fuel_station',
          lat: 50.0,
          lng: 16.75,
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'osm:node:off-route',
          name: 'Distant OMV',
          kind: 'fuel_station',
          lat: 50.0,
          lng: 17.25,
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });

      expect(result.pois.map((p) => p.external_id)).toEqual([
        'osm:node:on-route',
      ]);
      // On-route station sits 1° north of the start (lat 49 → lat 50)
      // ≈ 111 km along the route.
      const onRoute = result.pois[0];
      expect(onRoute.distance_along_route_km).toBeGreaterThan(109);
      expect(onRoute.distance_along_route_km).toBeLessThan(113);
      expect(onRoute.distance_from_route_km).toBeLessThan(0.1);
    });

    it('dedupes POIs keyed by external_id, keeping the closest-to-route match', async () => {
      // Same OSM id returned twice — once right on the route, once 1 km
      // off. Service must keep the on-route instance.
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:dup',
          name: 'OMV',
          kind: 'fuel_station',
          lat: 49.5,
          lng: 16.7649, // ~1 km east of the route
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'osm:node:dup',
          name: 'OMV',
          kind: 'fuel_station',
          lat: 49.5,
          lng: 16.75, // exactly on the route
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });

      expect(result.pois).toHaveLength(1);
      expect(result.pois[0].distance_from_route_km).toBeLessThan(0.1);
    });

    it('keeps an FSQ stop straddling the buffer when its OSM twin projects just outside (#869)', async () => {
      // The cross-source de-dupe must run AFTER the precise buffer filter, not
      // before it. Two copies of one venue 48 m apart (well inside the ~50 m
      // de-dupe radius) straddle a 2 km buffer on a horizontal route: the OSM
      // copy projects 2.024 km off-route (OUTSIDE), the FSQ copy 1.976 km
      // (INSIDE). De-duping first would keep OSM (preferred) and drop FSQ, then
      // the buffer filter would drop the OSM row too — the stop vanishes. With
      // de-dupe after projection, OSM is filtered out before it can suppress
      // anything, so the FSQ copy survives. lat-only offsets keep the off-route
      // distance a clean ~111.195 km/°, and both the projection and the de-dupe
      // radius use the same haversine, so the two sides agree exactly.
      const horizontalRoute = [
        { lat: 49.0, lng: 16.0 },
        { lat: 49.0, lng: 17.0 },
      ];
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:diner',
          name: 'Roadside Diner',
          kind: 'restaurant',
          lat: 49.0182022, // 2.024 km north of the route — just OUTSIDE 2 km
          lng: 16.5,
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'fsq:diner',
          name: 'Roadside Diner',
          kind: 'restaurant',
          lat: 49.0177707, // 1.976 km north — just INSIDE 2 km, 48 m from OSM
          lng: 16.5,
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route: horizontalRoute,
        buffer_km: 2,
      });

      // The FSQ copy survives; the OSM twin was outside the buffer. (The
      // reported distance rounds to the tenth — 100 m — so it can't resolve the
      // 48 m straddle; the surviving external_id is what proves de-dupe ran
      // after the buffer filter.)
      expect(result.pois.map((p) => p.external_id)).toEqual(['fsq:diner']);
      expect(result.pois[0].distance_from_route_km).toBeLessThanOrEqual(2);
    });

    it('ranks a de-duped venue by its closest copy so the cap keeps it (#869)', async () => {
      // Both copies are inside the buffer, but the FSQ copy projects CLOSER to
      // the route than its preferred OSM twin (0.14 vs 0.16 km, ~20 m apart). The
      // de-dupe keeps the OSM row (richer data); it must inherit the FSQ copy's
      // closer route distance so the per-kind distance sort + cap rank the venue
      // by its nearest member — otherwise the farther OSM distance could push it
      // past the cap and the venue would vanish. The two distances straddle a
      // rounding boundary (0.14 → 0.1, 0.16 → 0.2), so the carried distance is
      // observable despite the tenth-km rounding.
      const flatRoute = [
        { lat: 49.0, lng: 16.0 },
        { lat: 49.0, lng: 17.0 },
      ];
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:koliba',
          name: 'Koliba',
          kind: 'restaurant',
          lat: 49.0014389, // 0.16 km off-route → rounds to 0.2
          lng: 16.5,
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'fsq:koliba',
          name: 'Koliba',
          kind: 'restaurant',
          lat: 49.0012591, // 0.14 km off-route → rounds to 0.1, ~20 m from OSM
          lng: 16.5,
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route: flatRoute,
        buffer_km: 1,
      });

      // OSM row kept, but ranked/reported at the group's closest distance.
      expect(result.pois.map((p) => p.external_id)).toEqual(['osm:koliba']);
      expect(result.pois[0].distance_from_route_km).toBe(0.1); // FSQ's 0.14, not OSM's 0.16 → 0.2
    });

    it('keeps a nameless on-route fuel stop so the fuel-range warning can see it', async () => {
      // Unmanned / automated fuel stops on sparse routes often carry no
      // name, website, or phone — yet they are exactly what the fuel-range
      // warning must surface. The maps_url deep link makes them navigable,
      // so the ranker no longer drops them.
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:unmanned',
          name: null,
          kind: 'fuel_station',
          lat: 50.0,
          lng: 16.75, // right on the route
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });

      expect(result.pois.map((p) => p.external_id)).toEqual([
        'osm:node:unmanned',
      ]);
      expect(result.pois[0].maps_url).toContain(
        'www.google.com/maps/search/?api=1&query=',
      );
    });

    it('samples anchors at roughly `bufferKm` spacing along the polyline', async () => {
      // We don't assert the exact sampling strategy (that is tested
      // against `sampleRouteAnchors` separately); we just confirm the
      // service hands the provider multiple centre points for a long
      // route — the whole reason the endpoint exists.
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([]);

      await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 25, // big enough to stride 2+ samples over ~440 km
      });

      const passedSamples =
        provider.findPointsOfInterestAroundPoints.mock.calls[0][0];
      expect(Array.isArray(passedSamples)).toBe(true);
      expect(passedSamples.length).toBeGreaterThan(1);
    });

    it('defaults kinds to the full POI_KINDS set when none are provided', async () => {
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([]);

      await service.findPointsOfInterestAlongRoute({
        route,
      });

      const passedKinds =
        provider.findPointsOfInterestAroundPoints.mock.calls[0][2];
      expect(passedKinds).toEqual(
        expect.arrayContaining<PoiKind>([
          'restaurant',
          'cafe',
          'viewpoint',
          'fuel_station',
        ]),
      );
    });

    it('respects a narrowing kinds filter', async () => {
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:rest',
          name: 'Trattoria',
          kind: 'restaurant',
          lat: 50.0,
          lng: 16.75,
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'osm:node:fuel',
          name: 'Shell',
          kind: 'fuel_station',
          lat: 50.5,
          lng: 16.75,
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        kinds: ['fuel_station'],
      } as never);

      // Belt-and-suspenders — defence against a misbehaving provider
      // that ignores the kinds filter. The service still only returns
      // fuel stations to the client.
      expect(result.kinds).toEqual(['fuel_station']);
      expect(result.pois.map((p) => p.kind)).toEqual(['fuel_station']);
      expect(result.pois.map((p) => p.external_id)).toEqual(['osm:node:fuel']);
    });

    it('orders returned POIs by distance along the route', async () => {
      // Stations sit exactly on route vertices so the nearest-vertex
      // match is zero km off-route and the test doesn't turn into a
      // buffer-clipping check.
      provider.findPointsOfInterestAroundPoints.mockResolvedValue([
        {
          external_id: 'osm:node:late',
          name: 'Shell Prerov',
          kind: 'fuel_station',
          lat: 50.5,
          lng: 16.75,
          website: null,
          phone: null,
          hint: null,
        },
        {
          external_id: 'osm:node:early',
          name: 'OMV Brno',
          kind: 'fuel_station',
          lat: 49.5,
          lng: 16.75,
          website: null,
          phone: null,
          hint: null,
        },
      ]);

      const result = await service.findPointsOfInterestAlongRoute({
        route,
        buffer_km: 2,
      });

      expect(result.pois.map((p) => p.external_id)).toEqual([
        'osm:node:early',
        'osm:node:late',
      ]);
    });
  });
});

describe('cumulativeLengthKm', () => {
  it('returns a zeroed head and monotonically non-decreasing values', () => {
    const cum = cumulativeLengthKm([
      { lat: 49, lng: 16 },
      { lat: 49.5, lng: 16 },
      { lat: 50, lng: 16 },
    ]);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(cum[0]);
    expect(cum[2]).toBeGreaterThan(cum[1]);
    // ~111 km per degree of latitude — two half-degree hops ≈ 111 km.
    expect(cum[2]).toBeGreaterThan(109);
    expect(cum[2]).toBeLessThan(113);
  });
});

describe('sampleRouteAnchors', () => {
  const meridianRoute = Array.from({ length: 11 }, (_, i) => ({
    lat: 49 + i * 0.1, // ~11 km per 0.1 degree
    lng: 16,
  }));
  const cumKm = cumulativeLengthKm(meridianRoute);

  it('always includes the start and end vertices', () => {
    const anchors = sampleRouteAnchors(meridianRoute, cumKm, 5);
    expect(anchors[0]).toEqual({
      lat: meridianRoute[0].lat,
      lng: meridianRoute[0].lng,
    });
    expect(anchors[anchors.length - 1]).toEqual({
      lat: meridianRoute[meridianRoute.length - 1].lat,
      lng: meridianRoute[meridianRoute.length - 1].lng,
    });
  });

  it('spaces anchors roughly `bufferKm` apart so circles overlap', () => {
    const bufferKm = 15;
    const anchors = sampleRouteAnchors(meridianRoute, cumKm, bufferKm);
    // Route is ~111 km long; stride 15 km ≈ 8 anchors including
    // endpoints. Spacings are route-km between consecutive anchors.
    const spacings: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1];
      const b = anchors[i];
      // Re-derive the distance from their lat values since we only need
      // to assert the spacing bound. `111.2` matches the mean km-per-
      // degree-of-latitude used by the interpolator — stricter than the
      // textbook 111 km so the rounded bound doesn't sag below stride.
      spacings.push(Math.abs(b.lat - a.lat) * 111.2);
    }
    // Every interior spacing sits at ~bufferKm (the interpolator lands
    // on exact cumulative-km boundaries). Allow a little slack for the
    // haversine/flat-earth conversion plus a 2× upper bound for safety.
    for (const s of spacings.slice(0, -1)) {
      expect(s).toBeGreaterThanOrEqual(bufferKm - 0.05);
      expect(s).toBeLessThan(bufferKm * 2);
    }
  });

  it('returns a single anchor for a single-vertex input', () => {
    const single = sampleRouteAnchors([{ lat: 49, lng: 16 }], [0], 5);
    expect(single).toEqual([{ lat: 49, lng: 16 }]);
  });

  it('interpolates anchors inside long sparse segments', () => {
    // Only two vertices, ~111 km apart — vertex-only sampling would
    // produce just the endpoints and leave the middle of the segment
    // uncovered. The interpolating sampler should emit intermediate
    // anchors at each stride boundary.
    const sparseRoute = [
      { lat: 49, lng: 16 },
      { lat: 50, lng: 16 },
    ];
    const sparseCum = cumulativeLengthKm(sparseRoute);
    const bufferKm = 10;
    const anchors = sampleRouteAnchors(sparseRoute, sparseCum, bufferKm);

    // With 10 km stride over ~111 km, expect ≥ 10 interior anchors plus
    // the endpoints. Every interior anchor must sit strictly between the
    // two vertices (i.e. not be equal to either endpoint).
    expect(anchors.length).toBeGreaterThan(10);
    for (const a of anchors.slice(1, -1)) {
      expect(a.lat).toBeGreaterThan(49);
      expect(a.lat).toBeLessThan(50);
    }
  });
});

describe('projectOntoRoute', () => {
  // Two-vertex 111 km segment along a meridian, matching the sparse
  // polyline shape that breaks a nearest-vertex implementation.
  const route = [
    { lat: 49, lng: 16 },
    { lat: 50, lng: 16 },
  ];
  const cum = cumulativeLengthKm(route);

  it('projects a mid-segment point onto the segment, not the nearest vertex', () => {
    // Station at the exact midpoint of the segment, right on the route.
    // Nearest-vertex distance would be ~55 km; segment projection must
    // return ~0 km.
    const result = projectOntoRoute({ lat: 49.5, lng: 16 }, route, cum);
    expect(result.distance_from_route_km).toBeLessThan(0.1);
    expect(result.distance_along_route_km).toBeGreaterThan(54);
    expect(result.distance_along_route_km).toBeLessThan(57);
  });

  it('measures the perpendicular offset from a mid-segment point off to the side', () => {
    // 1 km east of the midpoint (~0.014° lng at lat 49.5).
    const result = projectOntoRoute({ lat: 49.5, lng: 16 + 0.014 }, route, cum);
    expect(result.distance_from_route_km).toBeGreaterThan(0.9);
    expect(result.distance_from_route_km).toBeLessThan(1.1);
    expect(result.distance_along_route_km).toBeGreaterThan(54);
    expect(result.distance_along_route_km).toBeLessThan(57);
  });

  it('clamps to the nearest endpoint when the projection falls outside the segment', () => {
    // Point beyond the end vertex — projection clamps to t=1 so the
    // along-route distance maxes out at the total route length.
    const totalKm = cum[cum.length - 1];
    const result = projectOntoRoute({ lat: 50.5, lng: 16 }, route, cum);
    expect(result.distance_along_route_km).toBeCloseTo(totalKm, 5);
  });
});
