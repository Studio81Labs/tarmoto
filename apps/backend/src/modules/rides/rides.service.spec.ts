/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RidesService } from './rides.service.js';
import { CsvService } from './csv.service.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';

describe('RidesService', () => {
  let service: RidesService;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let statsRepo: Partial<jest.Mocked<Repository<RideStats>>>;
  let segmentRepo: Partial<jest.Mocked<Repository<RideSegment>>>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RidesService,
        CsvService,
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(RideStats), useValue: statsRepo },
        { provide: getRepositoryToken(RideSegment), useValue: segmentRepo },
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
