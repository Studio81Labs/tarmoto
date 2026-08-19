import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Poi } from '@tarmoto/poi-db';
import {
  PoiStoreService,
  storedPoiToAccommodationPoi,
  storedPoiToPointOfInterest,
  toStoredPoiDto,
} from './poi-store.service.js';

function makePoi(over: Partial<Poi> = {}): Poi {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'osm',
    external_id: 'osm:node:42',
    kind: 'restaurant',
    name: 'Koliba',
    website: null,
    phone: null,
    // PostGIS geometry hydrated back to GeoJSON: [lng, lat].
    geom: { type: 'Point', coordinates: [18.4, 49.5] },
    opening_hours: 'Mo-Su 11:00-22:00',
    address_street: null,
    address_city: 'Brno',
    address_postcode: null,
    address_country: 'CZ',
    cuisine: 'regional',
    brand: null,
    stars: null,
    tags: null,
    google_place_id: null,
    fsq_id: null,
    enrichment_matched_at: null,
    last_imported_at: new Date('2026-07-06T00:00:00Z'),
    deactivated_at: null,
    import_region: null,
    created_at: new Date('2026-07-06T00:00:00Z'),
    updated_at: new Date('2026-07-06T00:00:00Z'),
    ...over,
  };
}

describe('toStoredPoiDto', () => {
  it('maps a stored Poi to the DTO with lat/lng from geom and an osm_url', () => {
    const dto = toStoredPoiDto(makePoi());
    expect(dto).toEqual(
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        source: 'osm',
        external_id: 'osm:node:42',
        kind: 'restaurant',
        name: 'Koliba',
        lat: 49.5,
        lng: 18.4,
        opening_hours: 'Mo-Su 11:00-22:00',
        address_city: 'Brno',
        address_country: 'CZ',
        cuisine: 'regional',
        osm_url: 'https://www.openstreetmap.org/node/42',
        maps_url:
          'https://www.google.com/maps/search/?api=1&query=Koliba%2049.5%2C18.4',
        last_imported_at: '2026-07-06T00:00:00.000Z',
      }),
    );
  });
});

describe('storedPoiToPointOfInterest', () => {
  it('maps a stored row to the raw PointOfInterest, cuisine as the food hint', () => {
    expect(storedPoiToPointOfInterest(makePoi())).toMatchObject({
      external_id: 'osm:node:42',
      kind: 'restaurant',
      lat: 49.5,
      lng: 18.4,
      hint: 'regional',
      cuisine: 'regional',
    });
  });

  it('uses the brand column as the hint for fuel stations', () => {
    const poi = storedPoiToPointOfInterest(
      makePoi({ kind: 'fuel_station', cuisine: null, brand: 'Shell' }),
    );
    expect(poi.hint).toBe('Shell');
  });

  it('derives a viewpoint hint from the raw tags bag (description)', () => {
    const poi = storedPoiToPointOfInterest(
      makePoi({
        kind: 'viewpoint',
        cuisine: null,
        brand: null,
        tags: { description: 'Panorama over the valley' },
      }),
    );
    expect(poi.hint).toBe('Panorama over the valley');
  });

  it('yields a null viewpoint hint when the tags bag is null', () => {
    const poi = storedPoiToPointOfInterest(
      makePoi({ kind: 'viewpoint', cuisine: null, brand: null, tags: null }),
    );
    expect(poi.hint).toBeNull();
  });
});

describe('storedPoiToAccommodationPoi', () => {
  it('maps a stored row to the raw AccommodationPoi with stars', () => {
    expect(
      storedPoiToAccommodationPoi(makePoi({ kind: 'hotel', stars: 4 })),
    ).toMatchObject({
      external_id: 'osm:node:42',
      kind: 'hotel',
      lat: 49.5,
      lng: 18.4,
      stars: 4,
    });
  });
});

describe('PoiStoreService', () => {
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    query: jest.Mock;
  };
  let service: PoiStoreService;

  beforeEach(() => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([{ covered: null }]),
    };
    service = new PoiStoreService({
      isInitialized: true,
      getRepository: () => repo as unknown as Repository<Poi>,
    } as unknown as DataSource);
  });

  const bbox = { minLng: 18, minLat: 49.3, maxLng: 18.9, maxLat: 49.75 };

  it('queries the bbox with ST_Intersects + ST_MakeEnvelope and caps the limit', async () => {
    qb.getMany.mockResolvedValueOnce([makePoi()]);
    const res = await service.findInBbox(bbox, undefined, 200);
    expect(repo.createQueryBuilder).toHaveBeenCalledWith('poi');
    const [sql, params] = qb.where.mock.calls[0] as [string, unknown];
    expect(sql).toContain('ST_Intersects');
    expect(sql).toContain('ST_MakeEnvelope');
    expect(params).toEqual(bbox);
    // No kinds → only the always-on tombstone filter (#850).
    expect(qb.andWhere).toHaveBeenCalledWith('poi.deactivated_at IS NULL');
    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    expect(qb.limit).toHaveBeenCalledWith(400); // 200 default × DEDUP_OVERFETCH
    expect(res[0]?.osm_url).toBe('https://www.openstreetmap.org/node/42');
  });

  it('de-dupes a cross-source pair (OSM wins) but keeps FSQ-only rows (#869)', async () => {
    qb.getMany.mockResolvedValueOnce([
      makePoi(), // OSM restaurant "Koliba" @ [18.4, 49.5]
      makePoi({
        id: 'fsq-dup',
        source: 'fsq',
        external_id: 'fsq:1',
        // ~7 m away, same kind + name → duplicate of the OSM row.
        geom: { type: 'Point', coordinates: [18.4001, 49.5] },
      }),
      makePoi({
        id: 'fsq-only',
        source: 'fsq',
        external_id: 'fsq:2',
        kind: 'cafe',
        name: 'Costa',
        geom: { type: 'Point', coordinates: [18.6, 49.6] },
      }),
    ]);
    const ids = (await service.findInBbox(bbox, undefined, 200)).map(
      (r) => r.external_id,
    );
    expect(ids).toContain('osm:node:42'); // OSM kept
    expect(ids).not.toContain('fsq:1'); // FSQ duplicate dropped
    expect(ids).toContain('fsq:2'); // FSQ-only kept (fills coverage)
  });

  it('adds a kind IN filter when kinds are supplied', async () => {
    await service.findInBbox(bbox, ['fuel_station', 'restaurant'], 100);
    // Tombstone filter is always applied first; the kind filter follows.
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      1,
      'poi.deactivated_at IS NULL',
    );
    const [sql, params] = qb.andWhere.mock.calls[1] as [string, unknown];
    expect(sql).toContain('poi.kind IN (:...kinds)');
    // #926: the map layer also gets the venue tag-match (gated on NOT IN).
    expect(sql).toContain('poi.tags @> :ktag0::jsonb AND poi.kind NOT IN');
    expect(params).toEqual({
      kinds: ['fuel_station', 'restaurant'],
      allKinds: ['fuel_station', 'restaurant'],
      ktag0: '{"amenity":"fuel"}',
      ktag1: '{"amenity":"restaurant"}',
    });
  });

  it('reclassifies a dual-tagged element for a secondary-kind bbox request (#926)', async () => {
    // The pannable map layer must surface a dual-tagged element under the
    // requested category too, served as that kind — matching the live path.
    qb.getMany.mockResolvedValueOnce([
      makePoi({
        external_id: 'osm:node:dual',
        kind: 'restaurant',
        name: 'Panorama Grill',
        tags: { amenity: 'restaurant', tourism: 'viewpoint' },
      }),
    ]);
    const res = await service.findInBbox(bbox, ['viewpoint'], 100);
    expect(res.map((r) => r.external_id)).toEqual(['osm:node:dual']);
    expect(res[0]?.kind).toBe('viewpoint');
  });

  it('orders exact stored-kind matches ahead of tag-only matches so the DB cap cannot starve them (#926)', async () => {
    // The DB LIMIT runs before reclassification, so dual-tagged rows (which
    // sort by their OWN stored kind, e.g. `restaurant` < `viewpoint`) must not
    // fill the cap ahead of real `kind = viewpoint` rows. Exact stored-kind
    // matches sort first (CASE → 0), tag-only matches after (CASE → 1).
    await service.findInBbox(bbox, ['viewpoint'], 100);
    expect((qb.orderBy.mock.calls[0] as [string, string])[0]).toBe(
      'CASE WHEN poi.kind IN (:...kinds) THEN 0 ELSE 1 END',
    );
    const addOrders = qb.addOrderBy.mock.calls.map((c) => (c as [string])[0]);
    expect(addOrders).toEqual(['poi.kind', 'poi.name']);
  });

  it('orders an all-kinds bbox read by stored kind directly, without the priority CASE (#926)', async () => {
    await service.findInBbox(bbox, undefined, 200);
    expect((qb.orderBy.mock.calls[0] as [string, string])[0]).toBe('poi.kind');
    expect(qb.addOrderBy.mock.calls.map((c) => (c as [string])[0])).toEqual([
      'poi.name',
    ]);
  });

  it('rejects an inverted bbox before touching the database', async () => {
    await expect(
      service.findInBbox(
        { minLng: 19, minLat: 49, maxLng: 18, maxLat: 50 },
        undefined,
        10,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('findById returns the mapped DTO or null', async () => {
    repo.findOne.mockResolvedValueOnce(makePoi());
    const found = await service.findById(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(found?.external_id).toBe('osm:node:42');

    repo.findOne.mockResolvedValueOnce(null);
    const missing = await service.findById('missing');
    expect(missing).toBeNull();
  });

  describe('findAlongRoute', () => {
    const route = [
      { lat: 49.5, lng: 18.4 },
      { lat: 49.6, lng: 18.6 },
    ];

    it('rejects a route shorter than two points', async () => {
      await expect(
        service.findAlongRoute([{ lat: 49.5, lng: 18.4 }], undefined, 2),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('queries ST_DWithin over the route line and annotates route distances', async () => {
      // A POI sitting on the first route vertex → ~0 along, ~0 off route.
      qb.getMany.mockResolvedValueOnce([
        makePoi({ geom: { type: 'Point', coordinates: [18.4, 49.5] } }),
      ]);
      const { pois, buffer_km } = await service.findAlongRoute(
        route,
        undefined,
        2,
      );
      const [sql, params] = qb.where.mock.calls[0] as [
        string,
        Record<string, number>,
      ];
      expect(sql).toContain('ST_DWithin');
      expect(sql).toContain('ST_MakeLine');
      expect(params).toMatchObject({
        buffer: 2000,
        lat0: 49.5,
        lng0: 18.4,
        lat1: 49.6,
        lng1: 18.6,
      });
      expect(buffer_km).toBe(2);
      expect(pois[0]?.distance_along_route_km).toBe(0);
      expect(pois[0]?.distance_from_route_km).toBeLessThanOrEqual(0.1);
      expect(pois[0]?.osm_url).toBe('https://www.openstreetmap.org/node/42');
    });

    it('caps per kind so a dense kind cannot crowd out sparser ones (#919)', async () => {
      // Several selected kinds → one bounded, closest-to-route query per kind,
      // so a dense kind (restaurants) can't fill a single global cap and starve
      // fuel / campgrounds that are also inside the buffer.
      await service.findAlongRoute(route, ['restaurant', 'fuel_station'], 20);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect((qb.orderBy.mock.calls[0] as [string, string])[0]).toContain(
        'ST_Distance',
      );
      expect(qb.limit).toHaveBeenCalledWith(200); // STORE_PER_KIND_LIMIT × DEDUP_OVERFETCH
    });

    it('falls back to a single global cap for an all-kinds read (#919)', async () => {
      // No kind list to partition → one closest-to-route query capped at
      // MAX_LIMIT, still bounded rather than an unbounded getMany().
      await service.findAlongRoute(route, undefined, 20);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(1000); // MAX_LIMIT × DEDUP_OVERFETCH
    });

    it('trims the per-kind de-dup overfetch back to the cap on an OSM-only read (#869)', async () => {
      // The DB overfetches STORE_PER_KIND_LIMIT × DEDUP_OVERFETCH for de-dup
      // headroom; with an OSM-only store (de-dup no-op) a single dense kind must
      // still be capped at STORE_PER_KIND_LIMIT, not the doubled fetch. Every
      // row sits on the first route vertex, so all are inside the buffer.
      const dense = Array.from({ length: 150 }, (_, i) =>
        makePoi({
          external_id: `osm:node:${i}`,
          geom: { type: 'Point', coordinates: [18.4 + i * 1e-5, 49.5] },
        }),
      );
      qb.getMany.mockResolvedValueOnce(dense);
      const { pois } = await service.findAlongRoute(route, ['restaurant'], 2);
      expect(pois).toHaveLength(100); // STORE_PER_KIND_LIMIT, not 200
    });

    it('trims the all-kinds overfetch to the nearest-to-route MAX_LIMIT before the route sort (#869)', async () => {
      // All-kinds → one global query fetching MAX_LIMIT × DEDUP_OVERFETCH rows,
      // nearest-to-route first. The overfetch must be trimmed to the MAX_LIMIT
      // NEAREST-to-route rows before the along-route sort — otherwise sorting all
      // 1000 by route position and slicing 500 keeps the earliest-along-route,
      // letting a far-off-route row displace a closer one. Flat route at lat 49.5
      // so along-route ∝ lng and off-route ∝ |lat − 49.5|. Rows are supplied
      // nearest-off-route first (the DB order); the nearest (i=0) is LATEST along
      // the route and the farthest (i=500) is EARLIEST — so the two orderings
      // disagree and the trim's effect is observable.
      const flatRoute = [
        { lat: 49.5, lng: 18.0 },
        { lat: 49.5, lng: 19.0 },
      ];
      const byDistance = Array.from({ length: 501 }, (_, i) =>
        makePoi({
          external_id: `osm:node:${i}`,
          geom: {
            type: 'Point',
            coordinates: [18.9 - i * 0.001, 49.5 + i * 1e-4],
          },
        }),
      );
      qb.getMany.mockResolvedValueOnce(byDistance);
      const { pois } = await service.findAlongRoute(flatRoute, undefined, 20);
      const ids = pois.map((p) => p.external_id);
      expect(pois).toHaveLength(500); // MAX_LIMIT, not 1000
      expect(ids).toContain('osm:node:0'); // nearest-to-route → kept
      expect(ids).not.toContain('osm:node:500'); // farthest-to-route → trimmed
    });

    it('clamps the buffer to the max and adds a kind filter', async () => {
      const { buffer_km } = await service.findAlongRoute(
        route,
        ['fuel_station'],
        999,
      );
      expect(buffer_km).toBe(20); // MAX_BUFFER_KM
      const params = (
        qb.where.mock.calls[0] as [string, Record<string, number>]
      )[1];
      expect(params.buffer).toBe(20_000);
      expect(qb.andWhere).toHaveBeenNthCalledWith(
        1,
        'poi.deactivated_at IS NULL',
      );
      const [kindSql, kindParams] = qb.andWhere.mock.calls[1] as [
        string,
        unknown,
      ];
      expect(kindSql).toContain('poi.kind IN (:...kinds)');
      // #926: also match the venue tag — but only when the stored kind wasn't
      // itself requested (NOT IN :allKinds), so it can't consume another kind's
      // budget (#926 review).
      expect(kindSql).toContain(
        'poi.tags @> :ktag0::jsonb AND poi.kind NOT IN (:...allKinds)',
      );
      expect(kindParams).toEqual({
        kinds: ['fuel_station'],
        allKinds: ['fuel_station'],
        ktag0: '{"amenity":"fuel"}',
      });
    });

    it('preserves a requested stored non-venue kind (hotel), not reclassifying it (#926)', async () => {
      // `/poi/in-corridor` accepts free-form stored kinds. A hotel carrying an
      // amenity=restaurant tag, requested alongside restaurant, must stay a
      // hotel — classifyPoiTags ignores `hotel`, so a naive reclassify would
      // mislabel it; a requested stored kind is preserved instead.
      qb.getMany.mockResolvedValueOnce([
        makePoi({
          external_id: 'osm:node:hotel',
          kind: 'hotel',
          name: 'Hotel Grill',
          tags: { amenity: 'restaurant', tourism: 'hotel' },
          geom: { type: 'Point', coordinates: [18.4, 49.5] }, // on the route
        }),
      ]);
      const { pois } = await service.findAlongRoute(
        route,
        ['hotel', 'restaurant'],
        2,
      );
      expect(pois.find((p) => p.external_id === 'osm:node:hotel')?.kind).toBe(
        'hotel',
      );
    });

    it('ignores a free-form kind that is an inherited Object property (e.g. toString) (#926)', async () => {
      // A bogus kind matching an Object.prototype member must not read the
      // inherited value and build a `tags @> \'{}\'` clause (which would match
      // essentially every POI). Own-property lookups only.
      await service.findAlongRoute(route, ['toString', 'restaurant'], 2);
      const tagPatterns = qb.andWhere.mock.calls
        .flatMap(([, params]) =>
          params ? Object.entries(params as Record<string, unknown>) : [],
        )
        .filter(([key]) => key.startsWith('ktag'))
        .map(([, value]) => value);
      // `toString` yields no tag-match; only the real `restaurant` pattern.
      expect(tagPatterns).not.toContain('{}');
      expect(tagPatterns).toContain('{"amenity":"restaurant"}');
    });
  });

  describe('findPointsOfInterestNear (store-first source)', () => {
    it('runs a geography ST_DWithin radius, nearest-first + capped, mapped to PointOfInterest', async () => {
      qb.getMany.mockResolvedValueOnce([makePoi()]);
      const pois = await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'restaurant',
      ]);
      const [sql, params] = qb.where.mock.calls[0] as [
        string,
        Record<string, number>,
      ];
      expect(sql).toContain('ST_DWithin');
      expect(sql).toContain('poi.geom::geography');
      expect(sql).toContain('ST_MakePoint');
      expect(params).toMatchObject({ lat: 49.5, lng: 18.4, radius: 5000 });
      expect(qb.andWhere).toHaveBeenNthCalledWith(
        1,
        'poi.deactivated_at IS NULL',
      );
      const [kindSql, kindParams] = qb.andWhere.mock.calls[1] as [
        string,
        unknown,
      ];
      expect(kindSql).toContain('poi.kind IN (:...kinds)');
      // #926: also match the venue tag, gated on NOT IN :allKinds (#926 review).
      expect(kindSql).toContain(
        'poi.tags @> :ktag0::jsonb AND poi.kind NOT IN (:...allKinds)',
      );
      expect(kindParams).toEqual({
        kinds: ['restaurant'],
        allKinds: ['restaurant'],
        ktag0: '{"amenity":"restaurant"}',
      });
      // Nearest-first + bounded per kind so a dense radius can't load unbounded
      // rows or let one kind crowd out sparser ones before rankPois.
      expect((qb.orderBy.mock.calls[0] as [string, string])[0]).toContain(
        'ST_Distance',
      );
      expect(qb.limit).toHaveBeenCalledWith(100); // STORE_PER_KIND_LIMIT (no overfetch — ranker de-dups)
      expect(pois[0]).toMatchObject({
        external_id: 'osm:node:42',
        kind: 'restaurant',
        lat: 49.5,
        lng: 18.4,
        hint: 'regional',
      });
    });

    it('caps each kind independently (rankPois caps per kind)', async () => {
      await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'restaurant',
        'fuel_station',
      ]);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(qb.limit).toHaveBeenCalledWith(100);
      const kindFilters = qb.andWhere.mock.calls
        .filter(([sql]) => String(sql).includes('poi.kind IN'))
        .map(([, params]) => (params as { kinds: string[] }).kinds);
      expect(kindFilters).toContainEqual(['restaurant']);
      expect(kindFilters).toContainEqual(['fuel_station']);
    });

    it('does not cross-source de-dup here — that is deferred to rankPois (#869)', async () => {
      // The ranker recomputes distance and caps, so de-duping by coordinate here
      // could drop a closer FSQ copy for a farther OSM twin. The store returns
      // both copies raw; PoiService.rankPois de-dups with the closest distance.
      qb.getMany.mockResolvedValueOnce([
        makePoi(), // OSM "Koliba" @ [18.4, 49.5]
        makePoi({
          id: 'fsq-dup',
          source: 'fsq',
          external_id: 'fsq:1',
          geom: { type: 'Point', coordinates: [18.4001, 49.5] }, // ~7 m, dup
        }),
      ]);
      const pois = await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'restaurant',
      ]);
      expect(pois.map((p) => p.external_id)).toEqual(['osm:node:42', 'fsq:1']);
    });

    it('reclassifies a dual-tagged element to the requested kind (#926)', async () => {
      // Stored under its amenity-first primary (restaurant) but also tagged
      // tourism=viewpoint. A viewpoint request must serve it AS a viewpoint,
      // matching the live Overpass path — the tag-match surfaces it and the
      // reclassify re-labels it.
      qb.getMany.mockResolvedValueOnce([
        makePoi({
          external_id: 'osm:node:dual',
          kind: 'restaurant',
          name: 'Panorama Grill',
          tags: { amenity: 'restaurant', tourism: 'viewpoint' },
        }),
      ]);
      const pois = await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'viewpoint',
      ]);
      expect(pois).toHaveLength(1);
      expect(pois[0]).toMatchObject({
        external_id: 'osm:node:dual',
        kind: 'viewpoint',
      });
    });

    it('serves a dual-tagged element once, under its amenity-first kind, when both kinds are requested (#926)', async () => {
      // restaurant + viewpoint both requested → two per-kind queries fetch the
      // same element (kind match + tag match). It must appear once, as
      // restaurant (amenity-first), exactly as classifyPoiTags would pick.
      const dual = makePoi({
        external_id: 'osm:node:dual',
        kind: 'restaurant',
        name: 'Panorama Grill',
        tags: { amenity: 'restaurant', tourism: 'viewpoint' },
      });
      qb.getMany
        .mockResolvedValueOnce([dual]) // restaurant per-kind query
        .mockResolvedValueOnce([dual]); // viewpoint per-kind query (tag match)
      const pois = await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'restaurant',
        'viewpoint',
      ]);
      const dualHits = pois.filter((p) => p.external_id === 'osm:node:dual');
      expect(dualHits).toHaveLength(1);
      expect(dualHits[0]?.kind).toBe('restaurant');
    });

    it('gates the secondary tag-match on the FULL requested set, so it cannot consume another kind budget (#926)', async () => {
      await service.findPointsOfInterestNear(49.5, 18.4, 5, [
        'restaurant',
        'viewpoint',
      ]);
      // Each per-kind query's tag-match excludes NOT IN allKinds = the whole
      // requested set — so a `restaurant`+`viewpoint` element (stored restaurant)
      // is found only by its own restaurant query, never tag-surfaced into the
      // viewpoint query's LIMIT budget.
      const tagMatches = qb.andWhere.mock.calls
        .filter(([sql]) => String(sql).includes('poi.tags @>'))
        .map(([, params]) => params as { allKinds: string[] });
      expect(tagMatches.length).toBeGreaterThan(0);
      for (const params of tagMatches) {
        expect(params.allKinds).toEqual(['restaurant', 'viewpoint']);
      }
    });
  });

  describe('findAccommodationsNear (store-first source)', () => {
    it('runs a single global radius query and maps to AccommodationPoi with stars', async () => {
      qb.getMany.mockResolvedValueOnce([
        makePoi({ kind: 'hotel', stars: 4, cuisine: null }),
      ]);
      const acc = await service.findAccommodationsNear(49.5, 18.4, 10, [
        'hotel',
      ]);
      // Accommodations rank globally (closest-N), so one query with the global
      // cap — no per-kind fan-out.
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(500); // MAX_LIMIT (no overfetch — ranker de-dups)
      const params = (
        qb.where.mock.calls[0] as [string, Record<string, number>]
      )[1];
      expect(params).toMatchObject({ lat: 49.5, lng: 18.4, radius: 10_000 });
      expect(acc[0]).toMatchObject({
        external_id: 'osm:node:42',
        kind: 'hotel',
        stars: 4,
      });
    });

    it('pushes min_stars into the query so unrated stays cannot fill the cap', async () => {
      await service.findAccommodationsNear(49.5, 18.4, 10, ['hotel'], 3);
      const starFilter = (
        qb.andWhere.mock.calls as Array<[string, { minStars?: number }]>
      ).find(([sql]) => sql.includes('poi.stars >='));
      expect(starFilter).toBeDefined();
      expect(starFilter?.[1]).toEqual({ minStars: 3 });
    });

    it('does not cross-source de-dup here — that is deferred to rank (#869)', async () => {
      // The ranker recomputes distance and slices, so de-duping by coordinate
      // here could drop a closer FSQ copy for a farther OSM twin. The store
      // returns both copies raw; PoiService.rank de-dups with the closest one.
      qb.getMany.mockResolvedValueOnce([
        makePoi({ kind: 'hotel', stars: 4, cuisine: null }),
        makePoi({
          id: 'fsq-dup',
          source: 'fsq',
          external_id: 'fsq:1',
          kind: 'hotel',
          stars: 4,
          cuisine: null,
          geom: { type: 'Point', coordinates: [18.4001, 49.5] }, // ~7 m, dup
        }),
      ]);
      const acc = await service.findAccommodationsNear(49.5, 18.4, 10, [
        'hotel',
      ]);
      expect(acc.map((a) => a.external_id)).toEqual(['osm:node:42', 'fsq:1']);
    });
  });

  describe('findPointsOfInterestInCorridor (store-first source)', () => {
    const route = [
      { lat: 49.5, lng: 18.4 },
      { lat: 49.6, lng: 18.6 },
    ];

    it('rejects a route shorter than two points', async () => {
      await expect(
        service.findPointsOfInterestInCorridor([{ lat: 49.5, lng: 18.4 }], 2, [
          'restaurant',
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('queries the ST_DWithin corridor and returns raw, unprojected PointOfInterest', async () => {
      qb.getMany.mockResolvedValueOnce([makePoi()]);
      const pois = await service.findPointsOfInterestInCorridor(route, 2, [
        'restaurant',
      ]);
      const [sql, params] = qb.where.mock.calls[0] as [
        string,
        Record<string, number>,
      ];
      expect(sql).toContain('ST_DWithin');
      expect(sql).toContain('ST_MakeLine');
      expect(params).toMatchObject({ buffer: 2000, lat0: 49.5, lng0: 18.4 });
      // Bounded closest-to-route so a dense corridor can't hydrate unbounded
      // rows (unlike findAlongRoute, which slices after projecting every hit).
      expect((qb.orderBy.mock.calls[0] as [string, string])[0]).toContain(
        'ST_Distance',
      );
      expect(qb.limit).toHaveBeenCalledWith(200); // CORRIDOR_STORE_PER_KIND_LIMIT × DEDUP_OVERFETCH
      // Raw shape — the service's rankAlongRoute does the projection, so no
      // along/off-route distances are computed here.
      expect(pois[0]).toMatchObject({
        external_id: 'osm:node:42',
        hint: 'regional',
      });
      expect(pois[0]).not.toHaveProperty('distance_along_route_km');
    });

    it('caps each kind independently so a dense kind cannot crowd out sparse ones', async () => {
      await service.findPointsOfInterestInCorridor(route, 2, [
        'restaurant',
        'fuel_station',
      ]);
      // One bounded, closest-to-route query per kind — not one global cap.
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(qb.limit).toHaveBeenCalledWith(200);
      const kindFilters = qb.andWhere.mock.calls
        .filter(([sql]) => String(sql).includes('poi.kind IN'))
        .map(([, params]) => (params as { kinds: string[] }).kinds);
      expect(kindFilters).toContainEqual(['restaurant']);
      expect(kindFilters).toContainEqual(['fuel_station']);
    });
  });

  describe('isRequestCovered (#944)', () => {
    it('radius: ST_Covers over the UNION of intersecting imported regions, gated on imported_at', async () => {
      repo.query.mockResolvedValueOnce([{ covered: true }]);
      const res = await service.isRequestCovered({
        kind: 'radius',
        lat: 49.5,
        lng: 18.4,
        radiusKm: 25,
      });
      expect(res).toBe(true);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('poi_import_regions');
      expect(sql).toContain('r.imported_at IS NOT NULL');
      expect(sql).toContain('ST_Covers');
      expect(sql).toContain('ST_MakePoint');
      expect(sql).toContain('ST_Buffer');
      // Union only the regions the request touches (#944 review), so a
      // cross-border request covered by two adjacent imported countries counts.
      expect(sql).toContain('ST_Union');
      expect(sql).toContain('ST_Intersects');
      // lng, lat, radius metres.
      expect(params).toEqual([18.4, 49.5, 25000]);
    });

    it('route: buffers a [lng,lat] LineString passed as ONE GeoJSON text param', async () => {
      repo.query.mockResolvedValueOnce([{ covered: false }]);
      const res = await service.isRequestCovered({
        kind: 'route',
        route: [
          { lat: 49, lng: 16 },
          { lat: 49.1, lng: 16.2 },
        ],
        bufferKm: 2,
      });
      expect(res).toBe(false);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ST_GeomFromGeoJSON');
      const line = JSON.parse(params[0] as string) as {
        type: string;
        coordinates: number[][];
      };
      expect(line.type).toBe('LineString');
      expect(line.coordinates).toEqual([
        [16, 49],
        [16.2, 49.1],
      ]); // [lng,lat]
      expect(params[1]).toBe(2000); // buffer metres
    });

    it('route: duplicates a lone point into a 2-vertex LineString so it still buffers to a disc', async () => {
      repo.query.mockResolvedValueOnce([{ covered: true }]);
      await service.isRequestCovered({
        kind: 'route',
        route: [{ lat: 49, lng: 16 }],
        bufferKm: 1,
      });
      const [, params] = repo.query.mock.calls[0] as [string, unknown[]];
      const line = JSON.parse(params[0] as string) as {
        coordinates: number[][];
      };
      expect(line.coordinates).toEqual([
        [16, 49],
        [16, 49],
      ]);
    });

    it('returns false for a non-finite descriptor without querying', async () => {
      const res = await service.isRequestCovered({
        kind: 'radius',
        lat: Number.NaN,
        lng: 18,
        radiusKm: 5,
      });
      expect(res).toBe(false);
      expect(repo.query).not.toHaveBeenCalled();
    });

    it('treats a null/empty aggregate as not covered', async () => {
      repo.query.mockResolvedValueOnce([]);
      expect(
        await service.isRequestCovered({
          kind: 'radius',
          lat: 49,
          lng: 18,
          radiusKm: 5,
        }),
      ).toBe(false);
    });
  });
});

function serviceWithDataSource(ds: Partial<DataSource>): PoiStoreService {
  return new PoiStoreService(ds as DataSource);
}

describe('PoiStoreService when the POI DB is down', () => {
  it('throws 503 from findInBbox when the DataSource is not initialized', async () => {
    const svc = serviceWithDataSource({ isInitialized: false });
    await expect(
      svc.findInBbox(
        { minLng: 18, minLat: 49, maxLng: 19, maxLat: 50 },
        undefined,
        50,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 503 from findById when the DataSource is not initialized', async () => {
    const svc = serviceWithDataSource({ isInitialized: false });
    await expect(svc.findById('id')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('PoiStoreService when a connected POI DB drops at runtime', () => {
  it('throws 503 (not the raw driver error) from findInBbox when the query fails with a connection error', async () => {
    const droppedQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockRejectedValue(
        Object.assign(new Error('Connection terminated unexpectedly'), {
          code: '08006',
        }),
      ),
    };
    const droppedRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(droppedQb),
    };
    const svc = serviceWithDataSource({
      isInitialized: true,
      getRepository: (() =>
        droppedRepo) as unknown as DataSource['getRepository'],
    });

    await expect(
      svc.findInBbox(
        { minLng: 18, minLat: 49, maxLng: 19, maxLat: 50 },
        undefined,
        50,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('PoiStoreService.isReady', () => {
  it('returns false without probing when the DataSource was never initialized', async () => {
    const query = jest.fn();
    const svc = serviceWithDataSource({ isInitialized: false, query });

    await expect(svc.isReady()).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns true when initialized and the live probe query resolves', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const svc = serviceWithDataSource({ isInitialized: true, query });

    await expect(svc.isReady()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns false when initialized but the connection dropped at runtime (probe rejects)', async () => {
    const query = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = serviceWithDataSource({ isInitialized: true, query });

    await expect(svc.isReady()).resolves.toBe(false);
  });
});
