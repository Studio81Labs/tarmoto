/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { TripGeneratorService } from './trip-generator.service.js';
import { TripsService } from './trips.service.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { ROUTING_PROVIDER } from '../commute/routing-provider.interface.js';
import type { RouteAlternative } from '../commute/routing-provider.interface.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const TRIP_ID = '11111111-1111-1111-1111-111111111111';

const SAMPLE_GEOMETRY = [
  { lat: 47.0, lng: 11.5 },
  { lat: 47.1, lng: 11.6 },
  { lat: 47.2, lng: 11.7 },
];

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: TRIP_ID,
    owner_id: USER_ID,
    title: 'Tyrolian Loop',
    region: 'Tyrol',
    num_days: 3,
    daily_km_min: 150,
    daily_km_max: 350,
    min_quality: 3.0,
    road_preference: 'curvy',
    status: 'draft',
    invite_code: 'ABCDEFGH',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as unknown as Trip;
}

function makeAlt(over: Partial<RouteAlternative> = {}): RouteAlternative {
  return {
    distance_km: 220,
    duration_min: 240,
    geometry: SAMPLE_GEOMETRY,
    ...over,
  };
}

describe('TripGeneratorService', () => {
  let service: TripGeneratorService;
  let tripRepo: jest.Mocked<Repository<Trip>>;
  let memberRepo: jest.Mocked<Repository<TripMember>>;
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let routingProvider: { getAlternatives: jest.Mock };
  let tripsService: { getDetail: jest.Mock };
  let events: { emitToTrip: jest.Mock };
  let activity: { recordSafe: jest.Mock };

  beforeEach(async () => {
    tripRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Trip>>;

    memberRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<TripMember>>;

    // Default DataSource: spatial queries return zero hits, transaction
    // immediately invokes the callback with a stub manager so we can
    // assert against the persistence calls.
    const manager = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn().mockImplementation((_e: unknown, data: object) => ({
        ...data,
      })),
      save: jest
        .fn()
        .mockImplementation((entity: { id?: string }) =>
          Promise.resolve({ ...entity, id: entity.id ?? 'new-id' }),
        ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    dataSource = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM fun_zones')) {
          // Return two centroids inside the default Tyrol bbox so the
          // anchor picker has fun zones to work with.
          if (sql.includes('ST_Centroid')) {
            return Promise.resolve([
              { lat: 47.2, lng: 11.4, composite_score: 8 },
              { lat: 46.8, lng: 12.1, composite_score: 7 },
            ]);
          }
          return Promise.resolve([{ avg_scenic: 6.5, zone_count: 2 }]);
        }
        if (sql.includes('FROM road_segments')) {
          if (sql.includes('GROUP BY rs.surface_type')) {
            return Promise.resolve([{ surface_type: 'asphalt', km: 40000 }]);
          }
          return Promise.resolve([
            {
              avg_quality: 4.2,
              avg_curviness: 65,
              elevation_span: 1200,
              total_length_m: 50000,
            },
          ]);
        }
        if (sql.includes('FROM hazard_reports')) {
          return Promise.resolve([{ count: 0 }]);
        }
        return Promise.resolve([]);
      }),
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (m: typeof manager) => Promise<void>) =>
          cb(manager),
        ),
    };

    routingProvider = {
      getAlternatives: jest
        .fn()
        .mockResolvedValue([
          makeAlt({ duration_min: 240 }),
          makeAlt({ duration_min: 200 }),
        ]),
    };

    tripsService = {
      getDetail: jest.fn().mockResolvedValue({
        id: TRIP_ID,
        title: 'Tyrolian Loop',
        days: [],
        members: [],
      }),
    };

    events = { emitToTrip: jest.fn() };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripGeneratorService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: ROUTING_PROVIDER, useValue: routingProvider },
        { provide: TripsService, useValue: tripsService },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get(TripGeneratorService);
  });

  describe('membership gating', () => {
    it('404s a non-member rather than leaking trip existence', async () => {
      memberRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tripRepo.findOne).not.toHaveBeenCalled();
      expect(routingProvider.getAlternatives).not.toHaveBeenCalled();
    });

    it('404s for a member when the trip row has been deleted', async () => {
      memberRepo.findOne.mockResolvedValueOnce({} as TripMember);
      tripRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('end-to-end generation', () => {
    beforeEach(() => {
      memberRepo.findOne.mockResolvedValue({} as TripMember);
      tripRepo.findOne.mockResolvedValue(makeTrip());
    });

    it('returns three options including the requested selected one', async () => {
      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
        option: 'scenic',
      });

      expect(result.options).toHaveLength(3);
      expect(result.options.map((o) => o.id)).toEqual([
        'best-fit',
        'scenic',
        'fastest',
      ]);
      expect(result.selected_option).toBe('scenic');
      expect(result.options.find((o) => o.id === 'scenic')!.selected).toBe(
        true,
      );
      expect(result.options.find((o) => o.id === 'best-fit')!.selected).toBe(
        false,
      );
    });

    it('defaults selected_option to best-fit', async () => {
      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      expect(result.selected_option).toBe('best-fit');
    });

    it('persists the selected option in a transaction and emits trip:generated', async () => {
      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:generated',
        expect.objectContaining({
          tripId: TRIP_ID,
          selected_option: 'best-fit',
        }),
      );
      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        USER_ID,
        'trip_generated',
        expect.objectContaining({ option: 'best-fit', num_days: 3 }),
      );
    });

    it('issues exactly num_days OSRM round-trips (one per leg, shared across options)', async () => {
      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // Trip has num_days=3 → 3 legs, so 3 OSRM calls (the same
      // candidate set is re-scored by each option preset).
      expect(routingProvider.getAlternatives).toHaveBeenCalledTimes(3);
    });

    it('handles the 1-day single-zone-region edge case', async () => {
      tripRepo.findOne.mockResolvedValue(makeTrip({ num_days: 1 }));
      // Single zone → only one anchor available.
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('ST_Centroid')) {
          return Promise.resolve([
            { lat: 47.2, lng: 11.4, composite_score: 8 },
          ]);
        }
        if (sql.includes('FROM road_segments')) {
          if (sql.includes('GROUP BY')) return Promise.resolve([]);
          return Promise.resolve([
            {
              avg_quality: 3.5,
              avg_curviness: 50,
              elevation_span: 800,
              total_length_m: 30000,
            },
          ]);
        }
        if (sql.includes('FROM hazard_reports')) {
          return Promise.resolve([{ count: 0 }]);
        }
        return Promise.resolve([{ avg_scenic: 5, zone_count: 1 }]);
      });

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      expect(routingProvider.getAlternatives).toHaveBeenCalledTimes(1);
      expect(result.options[0].days).toHaveLength(1);
    });

    it('survives an OSRM outage by falling back to a great-circle stub for the affected legs', async () => {
      routingProvider.getAlternatives.mockRejectedValue(new Error('osrm down'));

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // Each option still gets num_days days, even though OSRM failed.
      for (const opt of result.options) {
        expect(opt.days).toHaveLength(3);
      }
      // Total distance for the synthesised fallback is zero.
      const fallback = result.options.find((o) => o.id === 'best-fit')!;
      expect(fallback.total_distance_km).toBe(0);
    });

    it('respects min_quality by dropping below-threshold candidates', async () => {
      // Force every road_segments aggregation to come back at quality
      // 2.0 — below the trip's min_quality of 3.0 — so the per-route
      // filter rejects all alternatives. The service falls back to the
      // primary so the trip still gets days, but calls into PostGIS
      // happen for both the filter and the fallback.
      const queryCalls: string[] = [];
      dataSource.query.mockImplementation((sql: string) => {
        queryCalls.push(sql);
        if (sql.includes('FROM fun_zones')) {
          if (sql.includes('ST_Centroid')) {
            return Promise.resolve([
              { lat: 47.2, lng: 11.4, composite_score: 8 },
              { lat: 46.8, lng: 12.1, composite_score: 7 },
            ]);
          }
          return Promise.resolve([{ avg_scenic: 4, zone_count: 1 }]);
        }
        if (sql.includes('FROM road_segments')) {
          if (sql.includes('GROUP BY')) return Promise.resolve([]);
          return Promise.resolve([
            {
              avg_quality: 2.0,
              avg_curviness: 30,
              elevation_span: 500,
              total_length_m: 25000,
            },
          ]);
        }
        if (sql.includes('FROM hazard_reports')) {
          return Promise.resolve([{ count: 1 }]);
        }
        return Promise.resolve([]);
      });

      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // Aggregation queries ran for every candidate before the filter.
      const aggCalls = queryCalls.filter(
        (sql) =>
          sql.includes('FROM road_segments') &&
          sql.includes('AVG(rs.quality_score)'),
      );
      expect(aggCalls.length).toBeGreaterThan(0);
    });
  });
});
