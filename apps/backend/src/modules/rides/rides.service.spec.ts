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
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';

function makeQbSpy() {
  const andWhere = jest.fn().mockReturnThis();
  const orderBy = jest.fn().mockReturnThis();
  const qb = {
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
  let privacy: { loadPreferences: jest.Mock };

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
    };
    privacy = {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_PRIVACY_PREFERENCES }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RidesService,
        CsvService,
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(RideStats), useValue: statsRepo },
        { provide: getRepositoryToken(RideSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        { provide: PrivacyPreferencesService, useValue: privacy },
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
      } as Ride);

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

    it('should filter by ride type', async () => {
      const qb = {
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
      } as never);

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

    it('applies ST_DWithin when all near_* params are supplied', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {
        near_lat: 49.2,
        near_lng: 16.6,
        near_km: 25,
      } as never);

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
        service.list('user-1', { near_lat: 49.2, near_lng: 16.6 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the near filter when no near_* param is supplied', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', {} as never);

      const calls = andWhere.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((p) => p.includes('ST_DWithin'))).toBe(false);
    });

    it('escapes SQL wildcards in the q filter value', async () => {
      const { qb, andWhere } = makeQbSpy();
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.list('user-1', { q: '50%_\\off' } as never);

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

      await service.list('user-1', {} as never);

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
      });
      expect(rideRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Sunday loop' }),
      );
      expect(result.name).toBe('Sunday loop');
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
      } as Ride);
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
        { ...mockRide, id: 'ride-1' } as Ride,
        { ...mockRide, id: 'ride-2' } as Ride,
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

      const res = await service.getTracks('user-1', {} as never);

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

      const res = await service.getTracks('user-1', {} as never);
      expect(res.truncated).toBe(true);
    });

    it('excludes null-geometry rides at query level', async () => {
      const qb = makeTracksQbSpy([], 0);
      (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getTracks('user-1', {} as never);

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
        { ...mockRide, id: 'ride-1', route_geom: null } as Ride,
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
});
