/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DEFAULT_PRIVACY_PREFERENCES } from '@tarmoto/shared';
import { RidesService } from './rides.service.js';
import { CsvService } from './csv.service.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Bike } from '../../entities/bike.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { BikesService } from '../bikes/bikes.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

function makeQbSpy() {
  const andWhere = jest.fn().mockReturnThis();
  const orderBy = jest.fn().mockReturnThis();
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere,
    orderBy,
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return { qb, andWhere, orderBy };
}

describe('RidesService', () => {
  let service: RidesService;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let statsRepo: Partial<jest.Mocked<Repository<RideStats>>>;
  let segmentRepo: Partial<jest.Mocked<Repository<RideSegment>>>;
  let sharedRideRepo: Partial<jest.Mocked<Repository<SharedRide>>>;
  let bikeRepo: Partial<jest.Mocked<Repository<Bike>>>;
  let privacy: { loadPreferences: jest.Mock };
  let bikesService: { findActive: jest.Mock };
  let featureResolver: jest.Mocked<
    Pick<
      FeatureResolver,
      'isSystemSwitchEnabled' | 'resolveForUser' | 'getGlobalStates'
    >
  >;

  const mockRide = {
    id: 'ride-1',
    user_id: 'user-1',
    ride_type: 'free',
    status: 'active',
    started_at: new Date('2026-04-14T10:00:00Z'),
    ended_at: null,
    distance_km: null,
    avg_speed: null,
    max_speed: null,
    route_geom: null,
    avg_road_quality: null,
  } as Ride;

  beforeEach(async () => {
    rideRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockRide, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      // Default: no segments → aggregate is null. Individual tests
      // override this when they want to exercise a concrete value.
      query: jest.fn().mockResolvedValue([{ weighted_avg: null }]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      }),
    };
    statsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    segmentRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    sharedRideRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    bikeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };
    bikesService = {
      findActive: jest.fn().mockResolvedValue(null),
    };
    // Default ON / entitled so every pre-existing test is unaffected; the
    // off-case tests below override with mockResolvedValue(false) /
    // { advanced_ride_stats: false }.
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
      resolveForUser: jest
        .fn()
        .mockResolvedValue({ advanced_ride_stats: true }),
      // The GLOBAL flag map, distinct from the per-user snapshot above.
      // `road_quality_overlay` is an operator kill on the export path, so it
      // must resolve from here and NOT fold in a per-user override — an empty
      // map means "no force_off", i.e. live.
      getGlobalStates: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RidesService,
        CsvService,
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(RideStats), useValue: statsRepo },
        { provide: getRepositoryToken(RideSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        { provide: getRepositoryToken(Bike), useValue: bikeRepo },
        { provide: PrivacyPreferencesService, useValue: privacy },
        { provide: BikesService, useValue: bikesService },
        { provide: FeatureResolver, useValue: featureResolver },
      ],
    }).compile();

    service = module.get<RidesService>(RidesService);
  });

  describe('start', () => {
    it('should create a new ride', async () => {
      const result = await service.start('user-1', {});

      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          ride_type: 'free',
          status: 'active',
        }),
      );
      expect(result.status).toBe('active');
      expect(result.ride_type).toBe('free');
    });

    it('should accept custom ride type', async () => {
      await service.start('user-1', { ride_type: 'commute' });

      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ ride_type: 'commute' }),
      );
    });

    it('should reject if user already has active ride (unique violation)', async () => {
      rideRepo.save!.mockRejectedValueOnce({ code: '23505' });

      await expect(service.start('user-1', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    // ── US-64: bike_id resolution on /rides/start ──

    it('attributes the ride to the rider’s active bike when bike_id is omitted', async () => {
      bikesService.findActive.mockResolvedValueOnce({ id: 'bike-active' });

      await service.start('user-1', {});

      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ bike_id: 'bike-active' }),
      );
      expect(bikesService.findActive).toHaveBeenCalledWith('user-1');
      // Active-bike fallback path doesn't validate ownership against
      // `bikes` (already done by `findActive`'s where clause).
      expect(bikeRepo.findOne).not.toHaveBeenCalled();
    });

    it('falls back to bike_id=null when the rider has no garage', async () => {
      await service.start('user-1', {});

      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ bike_id: null }),
      );
    });

    it('uses an explicitly passed bike_id once ownership is verified', async () => {
      bikeRepo.findOne!.mockResolvedValueOnce({
        id: 'bike-2',
        user_id: 'user-1',
      } as never);

      await service.start('user-1', { bike_id: 'bike-2' });

      expect(bikeRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'bike-2', user_id: 'user-1' },
      });
      expect(rideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ bike_id: 'bike-2' }),
      );
      // Explicit bike_id wins; we don't fall back to active.
      expect(bikesService.findActive).not.toHaveBeenCalled();
    });

    it('rejects an explicit bike_id that does not belong to the rider', async () => {
      bikeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.start('user-1', { bike_id: 'someone-elses-bike' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(rideRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop an active ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });

      const result = await service.stop('user-1', 'ride-1');

      expect(result.status).toBe('completed');
      expect(result.ended_at).not.toBeNull();
    });

    it('should throw NotFoundException for missing ride', async () => {
      await expect(service.stop('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject stopping already completed ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        status: 'completed',
      });

      await expect(service.stop('user-1', 'ride-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recomputes avg_curviness and writes it back to the ride on stop', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      rideRepo.query!.mockResolvedValueOnce([{ weighted_avg: 3.4 }]);

      const result = await service.stop('user-1', 'ride-1');

      expect(rideRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('curviness_score * rs.length_m'),
        ['ride-1'],
      );
      expect(rideRepo.update).toHaveBeenCalledWith(
        { id: 'ride-1' },
        { avg_curviness: 3.4 },
      );
      expect(result.avg_curviness).toBe(3.4);
    });

    it('leaves avg_curviness null when no ride_segments exist yet', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      // Empty result set — the ride has no snapped segments at all, so
      // the SELECT returns a single row with `weighted_avg = null`.
      rideRepo.query!.mockResolvedValueOnce([{ weighted_avg: null }]);

      const result = await service.stop('user-1', 'ride-1');

      expect(rideRepo.update).toHaveBeenCalledWith(
        { id: 'ride-1' },
        { avg_curviness: null },
      );
      expect(result.avg_curviness).toBeNull();
    });

    it('coerces string numerics from pg back to float', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      rideRepo.query!.mockResolvedValueOnce([{ weighted_avg: '2.75' }]);

      const result = await service.stop('user-1', 'ride-1');

      expect(rideRepo.update).toHaveBeenCalledWith(
        { id: 'ride-1' },
        { avg_curviness: 2.75 },
      );
      expect(result.avg_curviness).toBe(2.75);
    });

    it('does NOT auto-share when default_ride_sharing is private (#279)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'private',
      });

      await service.stop('user-1', 'ride-1');

      expect(sharedRideRepo.save).not.toHaveBeenCalled();
    });

    it('auto-creates a public shared_ride when default_ride_sharing is public (#279)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'public',
      });

      await service.stop('user-1', 'ride-1');

      expect(sharedRideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ride_id: 'ride-1',
          user_id: 'user-1',
          is_public: true,
        }),
      );
      expect(sharedRideRepo.save).toHaveBeenCalled();
    });

    it('does not double-share when a shared_ride already exists for the ride (idempotent)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'public',
      });
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        id: 'existing-share',
      } as SharedRide);

      await service.stop('user-1', 'ride-1');

      expect(sharedRideRepo.create).not.toHaveBeenCalled();
      expect(sharedRideRepo.save).not.toHaveBeenCalled();
    });

    it('returns the completed ride even when auto-share fails (#279, non-fatal)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'public',
      });
      // Simulate a transient failure in the privacy load OR shared_ride
      // save — either should be logged-and-swallowed so `stop` keeps
      // returning the saved-as-completed ride to the caller.
      sharedRideRepo.save!.mockRejectedValueOnce(new Error('db hiccup'));

      const result = await service.stop('user-1', 'ride-1');

      expect(result.status).toBe('completed');
      expect(result.ended_at).not.toBeNull();
    });

    // sys_ride_publishing (operator kill switch) — directional gate on the
    // auto-publish-on-stop path. Off means auto-publish is skipped entirely
    // (the ride stays private); it does not affect stop() itself.
    it('skips default auto-publish when sys_ride_publishing is off', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      // Mirrors the happy-path setup (default_ride_sharing: 'public') so
      // this test fails for the right reason pre-fix — without the new
      // gate, this setup alone would auto-share.
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'public',
      });
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      await service.stop('user-1', 'ride-1');

      expect(sharedRideRepo.save).not.toHaveBeenCalled();
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_ride_publishing',
      );
    });

    it('treats unique-violation on auto-share as success (concurrent stop race)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({ ...mockRide });
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        default_ride_sharing: 'public',
      });
      // Postgres returns SQLSTATE '23505' on unique-index violation.
      // Both concurrent stop calls pass the findOne pre-check, but
      // only one wins the insert — the loser must NOT bubble a 500.
      const uniqueErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      sharedRideRepo.save!.mockRejectedValueOnce(uniqueErr);

      const result = await service.stop('user-1', 'ride-1');

      expect(result.status).toBe('completed');
    });
  });

  describe('toSummary', () => {
    it('includes name (null when unset)', () => {
      const r = { ...mockRide, name: null } as unknown as Ride;
      expect(service.toSummary(r).name).toBeNull();
    });

    it('includes name when set', () => {
      const r = { ...mockRide, name: 'Sunday loop' } as unknown as Ride;
      expect(service.toSummary(r).name).toBe('Sunday loop');
    });
  });

  describe('list', () => {
    it('should return paginated rides', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([
            [{ ...mockRide, ended_at: new Date('2026-04-14T11:00:00Z') }],
            1,
          ]),
      };
      rideRepo.createQueryBuilder!.mockReturnValueOnce(qb as never);

      const result = await service.list('user-1', {});

      expect(result.total).toBe(1);
      expect(result.rides).toHaveLength(1);
      expect(result.rides[0].duration_min).toBe(60);
    });

    it('surfaces max_lean_angle from the joined stats relation', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([
            [{ ...mockRide, stats: { max_lean_angle: 38 } }],
            1,
          ]),
      };
      rideRepo.createQueryBuilder!.mockReturnValueOnce(qb as never);

      const result = await service.list('user-1', {});

      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('ride.stats', 'stats');
      expect(result.rides[0].max_lean_angle).toBe(38);
    });

    it('returns null max_lean_angle when the ride has no stats', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([[{ ...mockRide, stats: null }], 1]),
      };
      rideRepo.createQueryBuilder!.mockReturnValueOnce(qb as never);

      const result = await service.list('user-1', {});

      expect(result.rides[0].max_lean_angle).toBeNull();
    });

    it('should filter by ride type', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      rideRepo.createQueryBuilder!.mockReturnValueOnce(qb as never);

      await service.list('user-1', { type: 'commute' });

      expect(qb.andWhere).toHaveBeenCalledWith('ride.ride_type = :type', {
        type: 'commute',
      });
    });

    it('should use custom limit and offset', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      rideRepo.createQueryBuilder!.mockReturnValueOnce(qb as never);

      await service.list('user-1', { limit: 5, offset: 10 });

      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(5);
    });
  });

  describe('list filters and sort', () => {
    it('applies date, distance, quality, type, and search filters', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        started_from: '2026-01-01',
        started_to: '2026-04-20',
        min_distance_km: 10,
        max_distance_km: 500,
        min_quality: 2,
        max_quality: 5,
        type: 'trip',
        q: 'sunday',
      });

      const predicates = andWhere.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(predicates).toEqual(
        expect.arrayContaining([
          expect.stringContaining('started_at >='),
          expect.stringContaining('started_at <'),
          expect.stringContaining('distance_km >='),
          expect.stringContaining('distance_km <='),
          expect.stringContaining('avg_road_quality >='),
          expect.stringContaining('avg_road_quality <='),
          expect.stringContaining('ride_type ='),
          expect.stringContaining('name ILIKE'),
        ]),
      );
    });

    it('treats a date-only started_to as inclusive end-of-day (< next day)', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', { started_to: '2026-04-20' });

      const call = andWhere.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('started_at <'),
      ) as [string, Record<string, string>] | undefined;
      expect(call).toBeDefined();
      expect(call![0]).toContain('started_at < :started_to_excl');
      expect(call![1].started_to_excl).toBe('2026-04-21T00:00:00.000Z');
    });

    it('treats a full-timestamp started_to as an exact instant bound (<=)', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', { started_to: '2026-04-20T15:30:00.000Z' });

      const call = andWhere.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('started_to_instant'),
      ) as [string, Record<string, string>] | undefined;
      expect(call).toBeDefined();
      expect(call![0]).toContain('started_at <= :started_to_instant');
      // Exact instant — no +1-day end-of-day widening.
      expect(call![1].started_to_instant).toBe('2026-04-20T15:30:00.000Z');
    });

    it('applies ST_DWithin when all near_* params are supplied', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        near_lat: 49.2,
        near_lng: 16.6,
        near_km: 25,
      });

      const call = andWhere.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('ST_DWithin'),
      ) as [string, Record<string, number>] | undefined;
      expect(call).toBeDefined();
      expect(call![0]).toContain('ride.route_geom::geography');
      expect(call![0]).toContain(
        'ST_SetSRID(ST_MakePoint(:near_lng, :near_lat), 4326)::geography',
      );
      expect(call![1]).toEqual({
        near_lng: 16.6,
        near_lat: 49.2,
        near_m: 25_000,
      });
    });

    it('rejects a partial near_* set with BadRequest', async () => {
      const { qb } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(
        service.list('user-1', { near_lat: 49.2, near_lng: 16.6 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the near filter when no near_* param is supplied', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {});

      const calls = andWhere.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((p) => p.includes('ST_DWithin'))).toBe(false);
    });

    it('escapes SQL wildcards in the q filter value', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', { q: '50%_\\off' });

      const ilikeCall = andWhere.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('name ILIKE'),
      ) as [string, { q: string }] | undefined;
      expect(ilikeCall).toBeDefined();
      expect(ilikeCall![1].q).toBe('%50\\%\\_\\\\off%');
    });

    it('sorts by distance_km asc when requested', async () => {
      const { qb, orderBy } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        sort: 'distance_km',
        order: 'asc',
      } as never);

      expect(orderBy).toHaveBeenCalledWith(
        'ride.distance_km',
        'ASC',
        'NULLS LAST',
      );
    });

    it('defaults sort to started_at DESC without NULLS clause', async () => {
      const { qb, orderBy } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {});

      expect(orderBy).toHaveBeenCalledWith('ride.started_at', 'DESC');
    });

    it('sorts avg_road_quality with NULLS LAST', async () => {
      const { qb, orderBy } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        sort: 'avg_road_quality',
        order: 'desc',
      } as never);

      expect(orderBy).toHaveBeenCalledWith(
        'ride.avg_road_quality',
        'DESC',
        'NULLS LAST',
      );
    });

    it('sorts duration via timestamp expression, NULLS LAST', async () => {
      const { qb, orderBy } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        sort: 'duration_min',
        order: 'asc',
      } as never);

      expect(orderBy).toHaveBeenCalledWith(
        '(ride.ended_at - ride.started_at)',
        'ASC',
        'NULLS LAST',
      );
    });
  });

  describe('getDetail', () => {
    it('should return ride with stats and segments', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        ended_at: new Date('2026-04-14T11:30:00Z'),
        route_geom: {
          coordinates: [
            [16.75, 49.1],
            [16.76, 49.11],
          ],
        },
      } as unknown as Ride);
      statsRepo.findOne!.mockResolvedValueOnce({
        elevation_gain: 150,
        elevation_loss: 80,
        curve_count: 12,
        max_lean_angle: 25,
        fuel_estimate_l: 3.2,
      } as RideStats);
      segmentRepo.find!.mockResolvedValueOnce([
        {
          road_segment_id: 'seg-1',
          road_segment: { road_name: 'D35' },
          quality_reading: 4.2,
          speed_avg: 65,
          speed_max: 91,
          lean_angle_max: 20,
        },
      ] as unknown as RideSegment[]);

      const result = await service.getDetail('user-1', 'ride-1');

      expect(result.duration_min).toBe(90);
      expect(result.route_geometry).toEqual([
        { lat: 49.1, lng: 16.75 },
        { lat: 49.11, lng: 16.76 },
      ]);
      expect(result.elevation_gain).toBe(150);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].road_name).toBe('D35');
      expect(result.segments[0]).toMatchObject({
        speed_max: 91,
      });
      expect(result.segments[0]).not.toHaveProperty('length_m');
      expect(result.segments[0]).not.toHaveProperty('elevation_profile');
    });

    it('should throw NotFoundException for missing ride', async () => {
      await expect(service.getDetail('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle ride with no stats or segments', async () => {
      rideRepo.findOne!.mockResolvedValueOnce(mockRide);

      const result = await service.getDetail('user-1', 'ride-1');

      expect(result.elevation_gain).toBeNull();
      expect(result.route_geometry).toBeNull();
      expect(result.segments).toEqual([]);
    });

    it('returns the owner a share token even for a link-only (non-public) share', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        user: { id: 'user-1', display_name: 'Owner', avatar_url: null },
      } as unknown as Ride);
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        share_token: 'tok-abc',
        is_public: false,
      } as never);

      const result = await service.getDetail('user-1', 'ride-1');

      expect(result.viewer_is_owner).toBe(true);
      expect(result.rider_id).toBe('user-1');
      expect(result.rider_name).toBe('Owner');
      // Owner gets the token regardless of is_public, and skips the privacy gate.
      expect(result.share_token).toBe('tok-abc');
      expect(privacy.loadPreferences).not.toHaveBeenCalled();
      // The owner viewing their own ride must not inflate the share view count.
      expect(sharedRideRepo.increment).not.toHaveBeenCalled();
    });

    it('lets a non-owner view a publicly shared, non-private ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        user: { id: 'user-1', display_name: 'Owner', avatar_url: null },
      } as unknown as Ride);
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        id: 'sr-1',
        share_token: 'tok-xyz',
        is_public: true,
      } as never);

      const result = await service.getDetail('viewer-2', 'ride-1');

      expect(result.viewer_is_owner).toBe(false);
      expect(result.rider_id).toBe('user-1');
      expect(result.share_token).toBe('tok-xyz');
      expect(sharedRideRepo.findOne).toHaveBeenCalledWith({
        where: { ride_id: 'ride-1' },
        select: ['id', 'share_token', 'is_public'],
      });
      // A non-owner visit counts as a shared-ride view (popularity metrics).
      expect(sharedRideRepo.increment).toHaveBeenCalledWith(
        { id: 'sr-1' },
        'view_count',
        1,
      );
    });

    it('404s for a non-owner when the ride owner is mid-deletion', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        user: {
          id: 'user-1',
          display_name: 'Owner',
          deleted_at: new Date('2026-04-30T10:00:00Z'),
        },
      } as unknown as Ride);
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        id: 'sr-1',
        share_token: 'tok-xyz',
        is_public: true,
      } as never);

      await expect(service.getDetail('viewer-2', 'ride-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(sharedRideRepo.increment).not.toHaveBeenCalled();
    });

    it('404s for a non-owner when the share is link-only (not public)', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        user: { id: 'user-1', display_name: 'Owner' },
      } as unknown as Ride);
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        share_token: 'tok-private',
        is_public: false,
      } as never);

      await expect(service.getDetail('viewer-2', 'ride-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s for a non-owner when the ride owner is private', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        user: { id: 'user-1', display_name: 'Owner' },
      } as unknown as Ride);
      sharedRideRepo.findOne!.mockResolvedValueOnce({
        share_token: 'tok-xyz',
        is_public: true,
      } as never);
      privacy.loadPreferences.mockResolvedValueOnce({
        ...DEFAULT_PRIVACY_PREFERENCES,
        profile_visibility: 'private',
      });

      await expect(service.getDetail('viewer-2', 'ride-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // advanced_ride_stats (Pro toggle) — gates advanced stat fields
  // (max_lean_angle, lean_distribution, elevation_gain/loss, per-segment
  // lean_angle_max) on both read paths for the REQUESTING viewer, not the
  // ride owner.
  describe('advanced_ride_stats gating', () => {
    const detailRide = {
      ...mockRide,
      ended_at: new Date('2026-04-14T11:30:00Z'),
    } as unknown as Ride;
    const detailStats = {
      elevation_gain: 150,
      elevation_loss: 80,
      curve_count: 12,
      max_lean_angle: 25,
      fuel_estimate_l: 3.2,
    } as RideStats;
    const detailSegments = [
      {
        road_segment_id: 'seg-1',
        road_segment: { road_name: 'D35' },
        quality_reading: 4.2,
        speed_avg: 65,
        speed_max: 91,
        lean_angle_max: 20,
      },
    ] as unknown as RideSegment[];

    describe('getDetail', () => {
      it('keeps advanced fields for an entitled viewer', async () => {
        featureResolver.resolveForUser.mockResolvedValueOnce({
          advanced_ride_stats: true,
        } as never);
        rideRepo.findOne!.mockResolvedValueOnce(detailRide);
        statsRepo.findOne!.mockResolvedValueOnce(detailStats);
        segmentRepo.find!.mockResolvedValueOnce(detailSegments);

        const result = await service.getDetail('user-1', 'ride-1');

        expect(featureResolver.resolveForUser).toHaveBeenCalledWith('user-1');
        expect(result.max_lean_angle).toBe(25);
        expect(result.elevation_gain).toBe(150);
        expect(result.elevation_loss).toBe(80);
        expect(result.segments[0]?.lean_angle_max).toBe(20);
      });

      it('nulls advanced fields for a non-entitled viewer, keeping basic stats', async () => {
        featureResolver.resolveForUser.mockResolvedValueOnce({
          advanced_ride_stats: false,
        } as never);
        rideRepo.findOne!.mockResolvedValueOnce(detailRide);
        statsRepo.findOne!.mockResolvedValueOnce(detailStats);
        segmentRepo.find!.mockResolvedValueOnce(detailSegments);

        const result = await service.getDetail('user-1', 'ride-1');

        expect(result.max_lean_angle).toBeNull();
        expect(result.elevation_gain).toBeNull();
        expect(result.elevation_loss).toBeNull();
        expect(result.lean_distribution).toBeNull();
        expect(result.segments[0]?.lean_angle_max).toBeNull();
        // basic stats + segment fields stay intact
        expect(result.distance_km).toBe(mockRide.distance_km);
        expect(result.duration_min).toBe(90);
        expect(result.segments[0]?.road_name).toBe('D35');
        expect(result.segments[0]?.speed_max).toBe(91);
      });

      // Regression guard: on a PUBLIC shared ride the gate must resolve the
      // requesting VIEWER's entitlement, never the owner's. A future change
      // that passed `ride.user_id` to `resolveForUser` would still pass the
      // owner-viewer tests above but leak the owner's paid stats to any
      // non-entitled stranger — this test fails in exactly that case.
      it('nulls advanced fields for a non-entitled NON-owner viewing a public shared ride', async () => {
        rideRepo.findOne!.mockResolvedValueOnce({
          ...detailRide,
          user: { id: 'user-1', display_name: 'Owner', avatar_url: null },
        } as unknown as Ride);
        sharedRideRepo.findOne!.mockResolvedValueOnce({
          id: 'sr-1',
          share_token: 'tok-xyz',
          is_public: true,
        } as never);
        statsRepo.findOne!.mockResolvedValueOnce(detailStats);
        segmentRepo.find!.mockResolvedValueOnce(detailSegments);
        // The VIEWER (viewer-2) is not entitled; the owner (user-1) is
        // irrelevant. Resolving the owner instead would return entitled here.
        featureResolver.resolveForUser.mockResolvedValueOnce({
          advanced_ride_stats: false,
        } as never);

        const result = await service.getDetail('viewer-2', 'ride-1');

        // Gate keyed on the viewer, not the owner.
        expect(featureResolver.resolveForUser).toHaveBeenCalledWith('viewer-2');
        expect(featureResolver.resolveForUser).not.toHaveBeenCalledWith(
          'user-1',
        );
        expect(result.viewer_is_owner).toBe(false);
        // Advanced fields stripped for the non-entitled viewer…
        expect(result.max_lean_angle).toBeNull();
        expect(result.elevation_gain).toBeNull();
        expect(result.elevation_loss).toBeNull();
        expect(result.segments[0]?.lean_angle_max).toBeNull();
        // …basic stats still flow through.
        expect(result.distance_km).toBe(mockRide.distance_km);
        expect(result.segments[0]?.road_name).toBe('D35');
      });
    });

    describe('list', () => {
      function qbWith(rides: unknown[]) {
        return {
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          skip: jest.fn().mockReturnThis(),
          take: jest.fn().mockReturnThis(),
          getManyAndCount: jest.fn().mockResolvedValue([rides, rides.length]),
        };
      }

      it('keeps max_lean_angle for an entitled viewer', async () => {
        featureResolver.resolveForUser.mockResolvedValueOnce({
          advanced_ride_stats: true,
        } as never);
        rideRepo.createQueryBuilder!.mockReturnValueOnce(
          qbWith([{ ...mockRide, stats: { max_lean_angle: 38 } }]) as never,
        );

        const result = await service.list('user-1', {});

        expect(result.rides[0]?.max_lean_angle).toBe(38);
      });

      it('nulls max_lean_angle for a non-entitled viewer, keeping basic stats', async () => {
        featureResolver.resolveForUser.mockResolvedValueOnce({
          advanced_ride_stats: false,
        } as never);
        rideRepo.createQueryBuilder!.mockReturnValueOnce(
          qbWith([
            {
              ...mockRide,
              distance_km: 42,
              stats: { max_lean_angle: 38 },
            },
          ]) as never,
        );

        const result = await service.list('user-1', {});

        expect(featureResolver.resolveForUser).toHaveBeenCalledWith('user-1');
        expect(result.rides[0]?.max_lean_angle).toBeNull();
        expect(result.rides[0]?.distance_km).toBe(42);
        expect(result.rides[0]).not.toHaveProperty('segments');
      });
    });
  });

  describe('rename', () => {
    it('updates the name and returns the summary', async () => {
      const existing = { ...mockRide, name: null } as unknown as Ride;
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
      (rideRepo.save as jest.Mock).mockImplementationOnce((r) =>
        Promise.resolve(r),
      );

      const result = await service.rename('user-1', 'ride-1', 'Sunday loop');

      expect(rideRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'ride-1', user_id: 'user-1' },
        relations: { stats: true },
      });
      expect(rideRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Sunday loop' }),
      );
      expect(result.name).toBe('Sunday loop');
    });

    it('returns hydrated max_lean_angle even when save drops the relation', async () => {
      const existing = {
        ...mockRide,
        name: null,
        stats: { max_lean_angle: 38 },
      } as unknown as Ride;
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
      // Simulate TypeORM returning a fresh instance without the eager
      // relation — the service must carry `stats` over from the loaded ride.
      (rideRepo.save as jest.Mock).mockImplementationOnce((r: Ride) =>
        Promise.resolve({ ...r, stats: undefined }),
      );

      const result = await service.rename('user-1', 'ride-1', 'Sunday loop');

      expect(result.max_lean_angle).toBe(38);
    });

    it('trims whitespace and coerces empty to null', async () => {
      const existing = { ...mockRide, name: 'old' } as unknown as Ride;
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
      (rideRepo.save as jest.Mock).mockImplementationOnce((r) =>
        Promise.resolve(r),
      );

      const result = await service.rename('user-1', 'ride-1', '   ');

      expect(rideRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: null }),
      );
      expect(result.name).toBeNull();
    });

    it('throws NotFound when ride missing', async () => {
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.rename('user-1', 'nope', 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('nulls max_lean_angle for a non-entitled viewer', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce({
        advanced_ride_stats: false,
      } as never);
      const existing = {
        ...mockRide,
        name: null,
        stats: { max_lean_angle: 38 },
      } as unknown as Ride;
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
      (rideRepo.save as jest.Mock).mockImplementationOnce((r) =>
        Promise.resolve(r),
      );

      const result = await service.rename('user-1', 'ride-1', 'Sunday loop');

      expect(featureResolver.resolveForUser).toHaveBeenCalledWith('user-1');
      expect(result.max_lean_angle).toBeNull();
      expect(result.name).toBe('Sunday loop');
    });

    // The entitlement is resolved BEFORE the save so a transient resolver
    // failure can't leave a committed-but-errored rename (a retrying client
    // would otherwise see a "failed" mutation that actually took effect).
    it('does not save when the entitlement lookup fails', async () => {
      const existing = { ...mockRide, name: null } as unknown as Ride;
      (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
      featureResolver.resolveForUser.mockRejectedValueOnce(
        new Error('pool exhausted'),
      );

      await expect(
        service.rename('user-1', 'ride-1', 'Sunday loop'),
      ).rejects.toThrow('pool exhausted');
      expect(rideRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('exportGpx', () => {
    it('should generate valid GPX XML', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        route_geom: {
          coordinates: [
            [16.75, 49.1],
            [16.76, 49.11],
          ],
        },
      } as unknown as Ride);

      const gpx = await service.exportGpx('user-1', 'ride-1');

      expect(gpx).toContain('<?xml version="1.0"');
      expect(gpx).toContain('<gpx version="1.1"');
      expect(gpx).toContain('lat="49.1" lon="16.75"');
      expect(gpx).toContain('lat="49.11" lon="16.76"');
    });

    it('should throw NotFoundException for missing ride', async () => {
      await expect(service.exportGpx('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for ride without route', async () => {
      rideRepo.findOne!.mockResolvedValueOnce(mockRide);

      await expect(service.exportGpx('user-1', 'ride-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('exportRideCsv', () => {
    it('returns header + one row for an existing ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        ended_at: new Date('2026-04-14T11:30:00Z'),
        distance_km: 42,
      });
      statsRepo.findOne!.mockResolvedValueOnce({
        elevation_gain: 100,
      } as RideStats);

      const csv = await service.exportRideCsv('user-1', 'ride-1');
      const lines = csv.trimEnd().split('\r\n');

      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('ride-1');
      expect(lines[1]).toContain('42');
    });

    it('throws NotFoundException for missing ride', async () => {
      await expect(service.exportRideCsv('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('blanks avg_road_quality only on a GLOBAL kill, not a per-user override', async () => {
      // `road_quality_overlay` is an operator kill: every companion surface
      // gates it through `useFeatureKillSwitch`, which reads the global flag
      // map and ignores per-user overrides. Resolving it from the user
      // snapshot here would blank the CSV for a rider whose pages still show
      // quality — the export and the UI must answer the same way.
      featureResolver.resolveForUser.mockResolvedValue({
        advanced_ride_stats: true,
        road_quality_overlay: false, // per-user override — must NOT matter
      } as never);
      rideRepo.findOne!.mockResolvedValue({
        ...mockRide,
        ended_at: new Date('2026-04-14T11:30:00Z'),
        distance_km: 42,
        avg_road_quality: 4.1,
      });
      statsRepo.findOne!.mockResolvedValue(null);

      const live = await service.exportRideCsv('user-1', 'ride-1');
      expect(live.trimEnd().split('\r\n')[1]).toContain('4.1');

      // Now the operator kills it globally.
      featureResolver.getGlobalStates.mockResolvedValue({
        road_quality_overlay: 'force_off',
      });
      const killed = await service.exportRideCsv('user-1', 'ride-1');
      expect(killed.trimEnd().split('\r\n')[1]).not.toContain('4.1');
      // Everything else still exported.
      expect(killed.trimEnd().split('\r\n')[1]).toContain('42');
    });

    it('blanks elevation_gain/elevation_loss/max_lean_angle for a non-entitled viewer', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce({
        advanced_ride_stats: false,
      } as never);
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        ended_at: new Date('2026-04-14T11:30:00Z'),
        distance_km: 42,
      });
      statsRepo.findOne!.mockResolvedValueOnce({
        elevation_gain: 100,
        elevation_loss: 90,
        curve_count: 5,
        max_lean_angle: 30,
        fuel_estimate_l: 2.1,
      } as RideStats);

      const csv = await service.exportRideCsv('user-1', 'ride-1');
      const row = csv.trimEnd().split('\r\n')[1].split(',');

      expect(featureResolver.resolveForUser).toHaveBeenCalledWith('user-1');
      // Row shape matches CsvService HEADERS: … distance_km(5), …,
      // elevation_gain(10), elevation_loss(11), curve_count(12),
      // max_lean_angle(13), fuel_estimate_l(14)
      expect(row[5]).toBe('42'); // basic stat stays intact
      expect(row[10]).toBe(''); // elevation_gain blanked
      expect(row[11]).toBe(''); // elevation_loss blanked
      expect(row[12]).toBe('5'); // curve_count NOT gated
      expect(row[13]).toBe(''); // max_lean_angle blanked
      expect(row[14]).toBe('2.1'); // fuel_estimate_l NOT gated
    });

    it('keeps advanced columns for an entitled viewer', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce({
        advanced_ride_stats: true,
      } as never);
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        ended_at: new Date('2026-04-14T11:30:00Z'),
      });
      statsRepo.findOne!.mockResolvedValueOnce({
        elevation_gain: 100,
        max_lean_angle: 30,
      } as RideStats);

      const csv = await service.exportRideCsv('user-1', 'ride-1');

      expect(csv).toContain('100');
      expect(csv).toContain('30');
    });
  });

  describe('exportAllCsv', () => {
    it('returns only the header when the user has no rides', async () => {
      rideRepo.find!.mockResolvedValueOnce([]);

      const csv = await service.exportAllCsv('user-1');
      const lines = csv.trimEnd().split('\r\n');

      expect(lines).toHaveLength(1);
      expect(statsRepo.find).not.toHaveBeenCalled();
    });

    it('joins rides with their stats by ride_id', async () => {
      rideRepo.find!.mockResolvedValueOnce([
        { ...mockRide, id: 'ride-1' },
        { ...mockRide, id: 'ride-2' },
      ]);
      statsRepo.find!.mockResolvedValueOnce([
        { ride_id: 'ride-1', elevation_gain: 100 } as RideStats,
      ]);

      const csv = await service.exportAllCsv('user-1');
      const lines = csv.trimEnd().split('\r\n');

      expect(lines).toHaveLength(3);
      // ride-1 has stats (elevation_gain = 100)
      expect(lines[1]).toContain('100');
      // ride-2 has no stats — elevation column should be empty
      expect(lines[2]).toContain('ride-2');
    });

    it('blanks max_lean_angle for a non-entitled viewer across all rows', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce({
        advanced_ride_stats: false,
      } as never);
      rideRepo.find!.mockResolvedValueOnce([{ ...mockRide, id: 'ride-1' }]);
      statsRepo.find!.mockResolvedValueOnce([
        {
          ride_id: 'ride-1',
          elevation_gain: 100,
          max_lean_angle: 30,
          curve_count: 5,
        } as RideStats,
      ]);

      const csv = await service.exportAllCsv('user-1');

      expect(featureResolver.resolveForUser).toHaveBeenCalledWith('user-1');
      expect(csv).not.toContain('30');
      expect(csv).toContain('5'); // curve_count not gated
    });
  });

  describe('getTracks', () => {
    function makeTracksQbSpy(
      rows: Array<{ id: string; geometry: string | null }>,
      count: number,
    ) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
        getCount: jest.fn().mockResolvedValue(count),
      };
      return qb;
    }

    it('returns simplified GeoJSON geometries and truncated=false below cap', async () => {
      const qb = makeTracksQbSpy(
        [
          {
            id: 'r1',
            geometry: JSON.stringify({
              type: 'LineString',
              coordinates: [
                [14, 50],
                [14.1, 50.1],
              ],
            }),
          },
        ],
        1,
      );
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const res = await service.getTracks('user-1', {});

      expect(res.tracks).toEqual([
        {
          id: 'r1',
          geometry: {
            type: 'LineString',
            coordinates: [
              [14, 50],
              [14.1, 50.1],
            ],
          },
        },
      ]);
      expect(res.truncated).toBe(false);
    });

    it('sets truncated=true when more than 500 rides match', async () => {
      const qb = makeTracksQbSpy([], 501);
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const res = await service.getTracks('user-1', {});
      expect(res.truncated).toBe(true);
    });

    it('bounds the geometry query at the overlay cap (default 500)', async () => {
      const qb = makeTracksQbSpy([], 0);
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getTracks('user-1', {});

      expect(qb.limit).toHaveBeenCalledWith(500);
    });

    it('excludes null-geometry rides at query level', async () => {
      const qb = makeTracksQbSpy([], 0);
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getTracks('user-1', {});

      const predicates = qb.andWhere.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(predicates).toEqual(
        expect.arrayContaining([
          expect.stringContaining('route_geom IS NOT NULL'),
        ]),
      );
    });
  });

  describe('exportAllGpx', () => {
    it('emits an empty <gpx> wrapper when there are no rides', async () => {
      rideRepo.find!.mockResolvedValueOnce([]);

      const gpx = await service.exportAllGpx('user-1');

      expect(gpx).toContain('<gpx version="1.1"');
      expect(gpx).not.toContain('<trk>');
    });

    it('skips rides without route_geom', async () => {
      rideRepo.find!.mockResolvedValueOnce([
        { ...mockRide, id: 'ride-1', route_geom: null },
        {
          ...mockRide,
          id: 'ride-2',
          route_geom: {
            coordinates: [
              [16.75, 49.1],
              [16.76, 49.11],
            ],
          },
        } as unknown as Ride,
      ]);

      const gpx = await service.exportAllGpx('user-1');

      expect(gpx.match(/<trk>/g)).toHaveLength(1);
      expect(gpx).toContain('lat="49.1" lon="16.75"');
    });

    it('emits one <trk> per ride with route_geom', async () => {
      rideRepo.find!.mockResolvedValueOnce([
        {
          ...mockRide,
          id: 'ride-1',
          route_geom: { coordinates: [[16.75, 49.1]] },
        } as unknown as Ride,
        {
          ...mockRide,
          id: 'ride-2',
          route_geom: { coordinates: [[17.0, 50.0]] },
        } as unknown as Ride,
      ]);

      const gpx = await service.exportAllGpx('user-1');

      expect(gpx.match(/<trk>/g)).toHaveLength(2);
    });
  });

  describe('stats', () => {
    // The aggregate builder (#1) carries select/addSelect + getRawOne; the
    // distinct-roads builder (#2) carries innerJoin + getRawOne. Each is
    // first run through applyRidesFilters, so andWhere must be chainable.
    function makeAggQbSpy(raw: {
      km: string;
      hours: string;
      quality: string | null;
      count: string;
    }) {
      const andWhere = jest.fn().mockReturnThis();
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        getRawOne: jest.fn().mockResolvedValue(raw),
      };
      return { qb, andWhere };
    }

    function makeRoadsQbSpy(raw: { roads: string }) {
      const andWhere = jest.fn().mockReturnThis();
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        getRawOne: jest.fn().mockResolvedValue(raw),
      };
      return { qb, andWhere };
    }

    it('aggregates distance/hours/quality/count + distinct roads for the filter', async () => {
      const agg = makeAggQbSpy({
        km: '1284',
        hours: '32',
        quality: '4.1',
        count: '8',
      });
      const roads = makeRoadsQbSpy({ roads: '47' });
      (rideRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(agg.qb)
        .mockReturnValueOnce(roads.qb);

      const res = await service.stats('user-1', { type: 'trip' });

      expect(res.total_distance_km).toBe(1284);
      expect(res.total_hours).toBe(32);
      expect(res.new_roads).toBe(47);
      expect(res.avg_quality).toBeCloseTo(4.1);
      expect(res.ride_count).toBe(8);

      // The same filter predicate is applied to BOTH builders.
      expect(
        agg.andWhere.mock.calls.some(
          (c: unknown[]) =>
            typeof c[0] === 'string' && c[0].includes('ride_type ='),
        ),
      ).toBe(true);
      expect(
        roads.andWhere.mock.calls.some(
          (c: unknown[]) =>
            typeof c[0] === 'string' && c[0].includes('ride_type ='),
        ),
      ).toBe(true);
    });

    it('returns unrounded totals so short-ride windows do not floor to zero', async () => {
      // A filter window of short rides: 0.4 km / ~20 min. Rounding these in
      // the service would report 0 km / 0 hrs even though rides exist.
      const agg = makeAggQbSpy({
        km: '0.4',
        hours: '0.3333',
        quality: '4.137',
        count: '1',
      });
      const roads = makeRoadsQbSpy({ roads: '1' });
      (rideRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(agg.qb)
        .mockReturnValueOnce(roads.qb);

      const res = await service.stats('user-1', {});

      expect(res.total_distance_km).toBeCloseTo(0.4);
      expect(res.total_hours).toBeCloseTo(0.3333);
      // avg_quality is served unrounded; the client formats it.
      expect(res.avg_quality).toBeCloseTo(4.137);
    });

    it('maps a null quality aggregate (no scored rides) to null', async () => {
      const agg = makeAggQbSpy({
        km: '0',
        hours: '0',
        quality: null,
        count: '0',
      });
      const roads = makeRoadsQbSpy({ roads: '0' });
      (rideRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(agg.qb)
        .mockReturnValueOnce(roads.qb);

      const res = await service.stats('user-1', {});

      expect(res.avg_quality).toBeNull();
      expect(res.ride_count).toBe(0);
      expect(res.new_roads).toBe(0);
    });
  });

  describe('breakdown', () => {
    // `breakdown()` calls `base()` twice (surface, then curviness) inside a
    // Promise.all. Each base() builds: createQueryBuilder → where →
    // applyRidesFilters (andWhere) → innerJoin → innerJoin, then
    // select/addSelect/groupBy/getRawMany.
    function makeBreakdownQb(rows: Array<{ key: string; meters: string }>) {
      const andWhere = jest.fn().mockReturnThis();
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere,
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      return { qb, andWhere };
    }

    it('returns distance-weighted surface + curviness percentages', async () => {
      const surface = makeBreakdownQb([
        { key: 'asphalt', meters: '7000' },
        { key: 'concrete', meters: '2000' },
        { key: 'gravel', meters: '1000' },
      ]);
      const curviness = makeBreakdownQb([
        { key: 'straight', meters: '2000' },
        { key: 'twisty', meters: '5000' },
        { key: 'hairpin', meters: '3000' },
      ]);
      (rideRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(surface.qb)
        .mockReturnValueOnce(curviness.qb);

      const res = await service.breakdown('user-1', { type: 'trip' });

      expect(res.total_meters).toBe(10000);
      // Surface: canonical order, zero-distance surfaces omitted.
      expect(res.surface).toEqual([
        { key: 'asphalt', meters: 7000, pct: 70 },
        { key: 'concrete', meters: 2000, pct: 20 },
        { key: 'gravel', meters: 1000, pct: 10 },
      ]);
      // Curviness: full straight→hairpin ladder, empty bands at 0%.
      expect(res.curviness.map((c) => c.key)).toEqual([
        'straight',
        'flowing',
        'twisty',
        'tight',
        'hairpin',
      ]);
      expect(res.curviness).toContainEqual({
        key: 'twisty',
        meters: 5000,
        pct: 50,
      });
      expect(res.curviness).toContainEqual({
        key: 'flowing',
        meters: 0,
        pct: 0,
      });

      // The active filter reaches the joined aggregate.
      expect(
        surface.andWhere.mock.calls.some(
          (c: unknown[]) =>
            typeof c[0] === 'string' && c[0].includes('ride_type ='),
        ),
      ).toBe(true);
    });

    it('returns an honest empty breakdown when no segments are snapped', async () => {
      const surface = makeBreakdownQb([]);
      const curviness = makeBreakdownQb([]);
      (rideRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(surface.qb)
        .mockReturnValueOnce(curviness.qb);

      const res = await service.breakdown('user-1', {});

      expect(res).toEqual({ surface: [], curviness: [], total_meters: 0 });
    });
  });
});
