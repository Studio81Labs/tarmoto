import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { PoiStoreService, toStoredPoiDto } from './poi-store.service.js';

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

describe('PoiStoreService', () => {
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };
  let repo: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
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
    // No kinds → no extra filter.
    expect(qb.andWhere).not.toHaveBeenCalled();
    expect(qb.limit).toHaveBeenCalledWith(200);
    expect(res[0]?.osm_url).toBe('https://www.openstreetmap.org/node/42');
  });

  it('adds a kind IN filter when kinds are supplied', async () => {
    await service.findInBbox(bbox, ['fuel_station', 'restaurant'], 100);
    const [sql, params] = qb.andWhere.mock.calls[0] as [string, unknown];
    expect(sql).toContain('poi.kind IN (:...kinds)');
    expect(params).toEqual({ kinds: ['fuel_station', 'restaurant'] });
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

    it('clamps the buffer to the max and adds a kind filter', async () => {
      const { buffer_km } = await service.findAlongRoute(
        route,
        ['fuel_station'],
        999,
      );
      expect(buffer_km).toBe(10); // MAX_BUFFER_KM
      const params = (
        qb.where.mock.calls[0] as [string, Record<string, number>]
      )[1];
      expect(params.buffer).toBe(10_000);
      const [kindSql, kindParams] = qb.andWhere.mock.calls[0] as [
        string,
        unknown,
      ];
      expect(kindSql).toContain('poi.kind IN (:...kinds)');
      expect(kindParams).toEqual({ kinds: ['fuel_station'] });
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
      getRepository: () => droppedRepo as unknown as Repository<Poi>,
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
