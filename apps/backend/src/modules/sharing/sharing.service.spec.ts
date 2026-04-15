/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SharingService } from './sharing.service.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Ride } from '../../entities/ride.entity.js';

describe('SharingService', () => {
  let service: SharingService;
  let sharedRideRepo: jest.Mocked<Partial<Repository<SharedRide>>>;
  let rideRepo: jest.Mocked<Partial<Repository<Ride>>>;

  const mockRide = {
    id: 'ride-1',
    user_id: 'user-1',
    status: 'completed',
    ride_type: 'free',
    started_at: new Date('2026-04-14T09:00:00Z'),
    ended_at: new Date('2026-04-14T10:30:00Z'),
    distance_km: 42.5,
    avg_speed: 65.3,
    max_speed: 120.0,
    avg_road_quality: 4.2,
    route_geom: {
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.15],
        [16.75, 49.1],
      ],
    },
  } as unknown as Ride;

  const mockShared = {
    id: 'shared-1',
    ride_id: 'ride-1',
    user_id: 'user-1',
    share_token: 'abc123def456abc123def456abc12345',
    is_public: true,
    created_at: new Date('2026-04-14T11:00:00Z'),
    ride: mockRide,
    user: { display_name: 'John Rider' },
  } as unknown as SharedRide;

  const mockQueryBuilder = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([mockShared]),
  };

  beforeEach(async () => {
    sharedRideRepo = {
      findOne: jest.fn().mockResolvedValue(mockShared),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockShared, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };
    rideRepo = {
      findOne: jest.fn().mockResolvedValue(mockRide),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SharingService,
        { provide: getRepositoryToken(SharedRide), useValue: sharedRideRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
      ],
    }).compile();

    service = module.get<SharingService>(SharingService);
    jest.clearAllMocks();
  });

  describe('toggleShare', () => {
    it('should create a new share for a completed ride', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null); // no existing share

      const result = await service.toggleShare('user-1', 'ride-1', true);

      expect(rideRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'ride-1', user_id: 'user-1' },
      });
      expect(sharedRideRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ride_id: 'ride-1',
          user_id: 'user-1',
          is_public: true,
        }),
      );
      expect(result.is_public).toBe(true);
      expect(result.share_token).toBeDefined();
      expect(result.share_url).toContain('/rides/shared/');
    });

    it('should update existing share when already shared', async () => {
      const result = await service.toggleShare('user-1', 'ride-1', false);

      expect(sharedRideRepo.create).not.toHaveBeenCalled();
      expect(sharedRideRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_public: false }),
      );
      expect(result.is_public).toBe(false);
    });

    it('should throw NotFoundException when ride not found', async () => {
      rideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(
        service.toggleShare('user-1', 'missing', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for active ride', async () => {
      rideRepo.findOne!.mockResolvedValueOnce({
        ...mockRide,
        status: 'active',
      } as unknown as Ride);

      await expect(
        service.toggleShare('user-1', 'ride-1', true),
      ).rejects.toThrow(BadRequestException);
    });

    it('should generate a 32-char hex token', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await service.toggleShare('user-1', 'ride-1', true);

      const createCall = sharedRideRepo.create!.mock.calls[0][0] as {
        share_token: string;
      };
      expect(createCall.share_token).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  describe('unshare', () => {
    it('should remove shared ride', async () => {
      await service.unshare('user-1', 'ride-1');

      expect(sharedRideRepo.findOne).toHaveBeenCalledWith({
        where: { ride_id: 'ride-1', user_id: 'user-1' },
      });
      expect(sharedRideRepo.remove).toHaveBeenCalledWith(mockShared);
    });

    it('should throw NotFoundException when not shared', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.unshare('user-1', 'ride-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getByToken', () => {
    it('should return shared ride detail', async () => {
      const result = await service.getByToken(
        'abc123def456abc123def456abc12345',
      );

      expect(sharedRideRepo.findOne).toHaveBeenCalledWith({
        where: {
          share_token: 'abc123def456abc123def456abc12345',
          is_public: true,
        },
        relations: ['ride', 'user'],
      });
      expect(result.id).toBe('ride-1');
      expect(result.rider_name).toBe('John Rider');
      expect(result.distance_km).toBe(42.5);
      expect(result.duration_min).toBe(90);
      expect(result.route_geometry).toHaveLength(3);
      expect(result.route_geometry![0]).toEqual({ lat: 49.2, lng: 16.6 });
    });

    it('should throw NotFoundException for invalid token', async () => {
      sharedRideRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getByToken('invalid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return null route_geometry when ride has no geom', async () => {
      const noGeomShared = {
        ...mockShared,
        ride: { ...mockRide, route_geom: null },
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(noGeomShared);

      const result = await service.getByToken('abc123');

      expect(result.route_geometry).toBeNull();
    });

    it('should default rider_name to Unknown when user is null', async () => {
      const noUserShared = {
        ...mockShared,
        user: undefined,
      } as unknown as SharedRide;
      sharedRideRepo.findOne!.mockResolvedValueOnce(noUserShared);

      const result = await service.getByToken('abc123');

      expect(result.rider_name).toBe('Unknown');
    });
  });

  describe('listCommunityRides', () => {
    it('should query nearby public rides with spatial filter', async () => {
      const result = await service.listCommunityRides(49.2, 16.6, 25, 20);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'sr.is_public = true',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'ride.route_geom IS NOT NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        { lng: 16.6, lat: 49.2, radius: 25000 },
      );
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(20);
      expect(result).toHaveLength(1);
      expect(result[0].rider_name).toBe('John Rider');
      expect(result[0].share_token).toBe('abc123def456abc123def456abc12345');
    });

    it('should return empty array when no rides nearby', async () => {
      mockQueryBuilder.getMany.mockResolvedValueOnce([]);

      const result = await service.listCommunityRides(0, 0, 10, 20);

      expect(result).toHaveLength(0);
    });

    it('should convert radius_km to meters', async () => {
      await service.listCommunityRides(49.2, 16.6, 50, 10);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ST_DWithin'),
        expect.objectContaining({ radius: 50000 }),
      );
    });

    it('should calculate duration_min correctly', async () => {
      const result = await service.listCommunityRides(49.2, 16.6, 25, 20);

      expect(result[0].duration_min).toBe(90);
    });
  });
});
