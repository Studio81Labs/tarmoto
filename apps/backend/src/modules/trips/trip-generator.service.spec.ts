import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { TripGeneratorService } from './trip-generator.service.js';
import { TripsService } from './trips.service.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { ROUTING_PROVIDER } from '../commute/routing-provider.interface.js';
import type { RouteAlternative } from '../commute/routing-provider.interface.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { RouteEnrichmentService } from '../routing/route-enrichment.service.js';
import { ClosuresService } from '../closures/closures.service.js';

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
  let tripsService: {
    getDetail: jest.Mock;
    assertCanMintOpenTrip: jest.Mock;
  };
  let events: { emitToTrip: jest.Mock };
  let activity: { recordSafe: jest.Mock };
  // Hoisted so persistence tests can inspect the calls the bulk-save
  // path made on the transaction's manager (delete / save / update).
  let manager: {
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

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
    // The persistence path bulk-saves arrays of entities (days first
    // to capture ids, then waypoints with the right `trip_day_id`),
    // so the mock has to handle both shapes. A naive `{...entity}`
    // spread would turn `[day0, day1]` into `{ '0': day0, '1': day1 }`
    // and every saved row would lose its `id`, masking foreign-key
    // linkage bugs that real TypeORM would surface immediately.
    let nextId = 1;
    const stampId = <T extends { id?: string }>(entity: T): T => ({
      ...entity,
      id: entity.id ?? `id-${nextId++}`,
    });
    manager = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn().mockImplementation((_e: unknown, data: object) => ({
        ...data,
      })),
      save: jest
        .fn()
        .mockImplementation(
          (entityOrArray: { id?: string } | { id?: string }[]) =>
            Promise.resolve(
              Array.isArray(entityOrArray)
                ? entityOrArray.map(stampId)
                : stampId(entityOrArray),
            ),
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
            return Promise.resolve([
              { surface_type: 'asphalt', length_m: 40000 },
            ]);
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
      // Regenerating a completed trip promotes it back to open, so it
      // routes through the shared max_active_trips gate; default to
      // unlimited (no-op) so the existing (draft-trip) generate tests are
      // unaffected — the check only fires for a completed source trip.
      assertCanMintOpenTrip: jest.fn().mockResolvedValue(undefined),
    };

    events = { emitToTrip: jest.fn() };
    activity = { recordSafe: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripGeneratorService,
        RouteEnrichmentService,
        { provide: getRepositoryToken(Trip), useValue: tripRepo },
        { provide: getRepositoryToken(TripMember), useValue: memberRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: ROUTING_PROVIDER, useValue: routingProvider },
        { provide: TripsService, useValue: tripsService },
        { provide: EventsGateway, useValue: events },
        { provide: TripActivityService, useValue: activity },
        {
          provide: ClosuresService,
          useValue: { exclusionPolygons: jest.fn().mockResolvedValue([]) },
        },
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

    it('403s viewers — regenerating the itinerary is a route write', async () => {
      memberRepo.findOne.mockResolvedValueOnce({
        role: 'viewer',
      } as TripMember);

      await expect(
        service.generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
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

    it('rejects at the max_active_trips cap when regenerating a completed trip, before routing', async () => {
      memberRepo.findOne.mockResolvedValueOnce({} as TripMember);
      tripRepo.findOne.mockResolvedValueOnce(makeTrip({ status: 'completed' }));
      // Owner is at cap — promoting the completed trip back to open is blocked.
      tripsService.assertCanMintOpenTrip.mockRejectedValueOnce(
        new ForbiddenException({ code: 'FEATURE_LIMIT_EXCEEDED' }),
      );

      await expect(
        service.generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tripsService.assertCanMintOpenTrip).toHaveBeenCalledWith(USER_ID);
      // Fail-fast: no expensive routing work before the cap rejection.
      expect(routingProvider.getAlternatives).not.toHaveBeenCalled();
    });

    it('does NOT check the cap when regenerating an already-open trip', async () => {
      memberRepo.findOne.mockResolvedValueOnce({} as TripMember);
      tripRepo.findOne.mockResolvedValueOnce(makeTrip({ status: 'planned' }));

      await service
        .generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
        })
        .catch(() => undefined);

      expect(tripsService.assertCanMintOpenTrip).not.toHaveBeenCalled();
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

    it('defaults selected_option from road_preference (curvy → scenic)', async () => {
      // Default fixture has road_preference='curvy', which the
      // generator now maps to the 'scenic' option preset.
      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      expect(result.selected_option).toBe('scenic');
    });

    it('persists the selected option in a transaction and emits both trip:updated and trip:generated', async () => {
      // road_preference='mixed' falls through to the 'best-fit' default
      // so this test pins both the persistence path and the default
      // mapping for the catch-all case in one shot.
      tripRepo.findOne.mockResolvedValue(
        makeTrip({ road_preference: 'mixed' }),
      );

      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // `trip:updated` carries the refreshed detail so collaborators
      // already listening on the trip room (the same channel
      // `TripsService.update` writes to) refresh their cached view —
      // `persistSelected` flipped `status` from `draft` to `planned`.
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:updated',
        expect.objectContaining({ id: TRIP_ID }),
      );
      expect(events.emitToTrip).toHaveBeenCalledWith(
        TRIP_ID,
        'trip:generated',
        expect.objectContaining({
          tripId: TRIP_ID,
          selected_option: 'best-fit',
        }),
      );
      // Persistence path bulk-saves days first, then waypoints. Pull
      // the resolved value of the day-batch save (the mock stamps real
      // ids onto each row) and assert every waypoint passed to the
      // waypoint-batch save references one of those ids — the
      // original shape of this test would have passed even when the
      // array-spread mock dropped ids on the floor and the FK was
      // silently broken.
      const saveCalls = manager.save.mock.calls as Array<[unknown]>;
      const saveResults = manager.save.mock.results as Array<{
        type: string;
        value: unknown;
      }>;
      const dayBatchIdx = saveCalls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          (call[0] as Array<{ day_number?: number }>)[0]?.day_number !==
            undefined,
      );
      const waypointBatchIdx = saveCalls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          (call[0] as Array<{ waypoint_type?: string }>)[0]?.waypoint_type !==
            undefined,
      );
      expect(dayBatchIdx).toBeGreaterThanOrEqual(0);
      expect(waypointBatchIdx).toBeGreaterThanOrEqual(0);

      const savedDays = (await Promise.resolve(
        saveResults[dayBatchIdx].value,
      )) as Array<{ id: string }>;
      const savedDayIds = new Set(savedDays.map((d) => d.id));

      const waypointInputs = saveCalls[waypointBatchIdx][0] as Array<{
        trip_day_id: string | undefined;
      }>;
      expect(waypointInputs.length).toBeGreaterThan(0);
      for (const w of waypointInputs) {
        expect(w.trip_day_id).toBeDefined();
        expect(savedDayIds.has(w.trip_day_id ?? '')).toBe(true);
      }

      expect(activity.recordSafe).toHaveBeenCalledWith(
        TRIP_ID,
        USER_ID,
        'trip_generated',
        expect.objectContaining({ option: 'best-fit', num_days: 3 }),
      );
    });

    it('marks generated successor days start_linked when their start sits on the previous overnight', async () => {
      const A = { lat: 47.0, lng: 11.5 };
      const B = { lat: 47.2, lng: 11.7 };
      const C = { lat: 47.4, lng: 11.9 };
      // Chain the three legs so each starts where the previous ended:
      // day1 A→B, day2 B→C, day3 C→A (loop back to the trip start).
      routingProvider.getAlternatives
        .mockReset()
        .mockResolvedValueOnce([makeAlt({ geometry: [A, B] })])
        .mockResolvedValueOnce([makeAlt({ geometry: [B, C] })])
        .mockResolvedValueOnce([makeAlt({ geometry: [C, A] })])
        .mockResolvedValue([makeAlt({ geometry: [A, B] })]);

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: A,
        option: 'best-fit',
      });

      // Preview days for the selected option carry the linked flags:
      // day 1 is never linked; days 2-3 start on the previous overnight.
      const selected = result.options.find((o) => o.id === 'best-fit')!;
      expect(selected.days.map((d) => d.start_linked)).toEqual([
        false,
        true,
        true,
      ]);

      // The persisted TripDay rows carry the same flags (not the column
      // default) so the companion mirrors the boundary instead of drawing a
      // duplicate marker on the overnight stop.
      const persistedDays = manager.create.mock.calls
        .map(([, body]) => body as Record<string, unknown>)
        .filter((b) => 'day_number' in b && 'route_geom' in b)
        .sort((a, b) => (a.day_number as number) - (b.day_number as number));
      expect(persistedDays.map((d) => d.start_linked)).toEqual([
        false,
        true,
        true,
      ]);
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

      // 1-day trips are roundtrips: outbound leg + return leg.
      expect(routingProvider.getAlternatives).toHaveBeenCalledTimes(2);
      expect(result.options[0].days).toHaveLength(1);
      // The day is the MERGED loop: out + back distances summed. (The
      // mock returns one canned geometry per leg, so literal geometric
      // closure can't be asserted here — the merge itself is the
      // contract: both legs' 220 km land in one day.)
      const day = result.options[0].days[0];
      expect(day.distance_km).toBe(440);
      // The turnaround is persisted as a via so a waypoint-based
      // re-route keeps the loop instead of collapsing start→end.
      expect(day.waypoints.map((w) => w.waypoint_type)).toContain('via');
      expect(day.waypoints[day.waypoints.length - 1].waypoint_type).toBe('end');
    });

    it('averages loop metrics only over the legs that have data', async () => {
      // Regression: a null metric on one half of the roundtrip used to
      // count as ZERO over the full loop distance, halving the merged
      // score whenever one leg crossed an under-mapped area.
      tripRepo.findOne.mockResolvedValue(makeTrip({ num_days: 1 }));
      // Distinct geometries per leg so the enrichment queries (keyed on
      // the WKT parameter) can tell the legs apart.
      const BACK_LNG = 11.987654;
      routingProvider.getAlternatives
        .mockResolvedValueOnce([
          makeAlt({
            geometry: [
              { lat: 47.0, lng: 11.5 },
              { lat: 47.2, lng: 11.4 },
            ],
          }),
        ])
        .mockResolvedValueOnce([
          makeAlt({
            geometry: [
              { lat: 47.2, lng: 11.4 },
              { lat: 47.0, lng: BACK_LNG },
            ],
          }),
        ]);
      dataSource.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('ST_Centroid')) {
          return Promise.resolve([
            { lat: 47.2, lng: 11.4, composite_score: 8 },
          ]);
        }
        if (sql.includes('AVG(quality_score)')) {
          // The return leg has no quality-scored segments at all.
          const wkt = typeof params?.[0] === 'string' ? params[0] : '';
          if (wkt.includes(String(BACK_LNG))) return Promise.resolve([]);
          return Promise.resolve([
            {
              avg_quality: 4,
              avg_curviness: 60,
              elevation_span: 500,
              total_length_m: 30000,
            },
          ]);
        }
        if (sql.includes('FROM road_segments')) {
          return Promise.resolve([]);
        }
        if (sql.includes('FROM hazard_reports')) {
          return Promise.resolve([{ count: 0 }]);
        }
        return Promise.resolve([{ avg_scenic: 5, zone_count: 1 }]);
      });

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // Equal-length legs: zero-dilution would have halved this to 2.
      expect(result.options[0].days[0].avg_quality).toBe(4);
    });

    it('does NOT generate a degenerate start→start leg for a 1-day trip when fun zones exist', async () => {
      // Regression for the bug where `pickAnchors(.., numDays - 1)`
      // collapsed to 0 anchors on a 1-day trip, producing a 0 km loop
      // that ignored every available fun zone in the bbox.
      tripRepo.findOne.mockResolvedValue(makeTrip({ num_days: 1 }));

      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // Roundtrip: outbound + return legs.
      expect(routingProvider.getAlternatives).toHaveBeenCalledTimes(2);
      const [originLat, originLng, destLat, destLng] = routingProvider
        .getAlternatives.mock.calls[0] as [
        number,
        number,
        number,
        number,
        number,
      ];
      // Origin is the supplied start; destination must be a real anchor
      // (not the start) so the trip actually goes somewhere.
      expect(originLat).toBe(47.0);
      expect(originLng).toBe(11.5);
      const isDegenerate = originLat === destLat && originLng === destLng;
      expect(isDegenerate).toBe(false);
      // The return leg routes anchor → start.
      const [backOriginLat, backOriginLng, backDestLat, backDestLng] =
        routingProvider.getAlternatives.mock.calls[1] as [
          number,
          number,
          number,
          number,
          number,
        ];
      expect(backOriginLat).toBe(destLat);
      expect(backOriginLng).toBe(destLng);
      expect(backDestLat).toBe(47.0);
      expect(backDestLng).toBe(11.5);
    });

    it('defaults selected_option from trip.road_preference when caller omits option', async () => {
      tripRepo.findOne.mockResolvedValue(makeTrip({ road_preference: 'fast' }));

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
      });

      // road_preference=fast → fastest preset is selected by default.
      expect(result.selected_option).toBe('fastest');
    });

    it('explicit dto.option always wins over road_preference default', async () => {
      tripRepo.findOne.mockResolvedValue(makeTrip({ road_preference: 'fast' }));

      const result = await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
        option: 'scenic',
      });

      expect(result.selected_option).toBe('scenic');
    });

    it('plumbs avoid_highways and avoid_tolls through to the routing provider', async () => {
      // Regression: the DTO accepted these flags and the API documented
      // them, but earlier revisions never forwarded them — riders got
      // routes with motorways/tolls regardless of preference. The
      // RoutingOptions argument is the 6th positional param.
      await service.generate(USER_ID, TRIP_ID, {
        start_location: { lat: 47.0, lng: 11.5 },
        avoid_highways: true,
        avoid_tolls: true,
      });

      expect(routingProvider.getAlternatives).toHaveBeenCalled();
      const calls = routingProvider.getAlternatives.mock.calls as Array<
        [number, number, number, number, number, Record<string, unknown>]
      >;
      for (const call of calls) {
        // call shape: (originLat, originLng, destLat, destLng, max, options)
        expect(call[5]).toMatchObject({
          avoidHighways: true,
          avoidTolls: true,
        });
      }
    });

    it('rejects contradictory surface filters (gravel/dirt + avoid_unpaved) with 400', async () => {
      // Without the explicit guard, an empty effective filter would
      // silently reject every OSRM candidate and the fallback would
      // re-add the primary route as if the rider's filter never ran.
      // A 400 with a clear message tells the caller their inputs
      // contradict each other.
      await expect(
        service.generate(USER_ID, TRIP_ID, {
          start_location: { lat: 47.0, lng: 11.5 },
          surfaces: ['gravel', 'dirt'],
          avoid_unpaved: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(routingProvider.getAlternatives).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
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
          sql.includes('AVG(quality_score)'),
      );
      expect(aggCalls.length).toBeGreaterThan(0);
    });
  });
});
