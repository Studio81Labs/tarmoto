/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RidesController } from './rides.controller.js';
import { RidesService } from './rides.service.js';

describe('RidesController', () => {
  let controller: RidesController;
  let service: jest.Mocked<RidesService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockRide = {
    id: 'ride-1',
    status: 'active',
    ride_type: 'free',
    started_at: '2026-04-14T10:00:00.000Z',
    ended_at: null,
    distance_km: null,
    avg_speed: null,
    avg_road_quality: null,
  };

  beforeEach(async () => {
    const mockService = {
      start: jest.fn().mockResolvedValue(mockRide),
      stop: jest.fn().mockResolvedValue({ ...mockRide, status: 'completed' }),
      list: jest.fn().mockResolvedValue({ rides: [mockRide], total: 1 }),
      getDetail: jest.fn().mockResolvedValue(mockRide),
      exportGpx: jest.fn().mockResolvedValue('<gpx></gpx>'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RidesController],
      providers: [
        { provide: RidesService, useValue: mockService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();

    controller = module.get<RidesController>(RidesController);
    service = module.get(RidesService);
  });

  describe('POST /rides/start', () => {
    it('should start a ride', async () => {
      const result = await controller.start(mockReq, {});

      expect(service.start).toHaveBeenCalledWith('user-1', {});
      expect(result.status).toBe('active');
    });
  });

  describe('POST /rides/:rideId/stop', () => {
    it('should stop a ride', async () => {
      const result = await controller.stop(mockReq, 'ride-1');

      expect(service.stop).toHaveBeenCalledWith('user-1', 'ride-1');
      expect(result.status).toBe('completed');
    });
  });

  describe('GET /rides', () => {
    it('should return ride list', async () => {
      const result = await controller.list(mockReq, {});

      expect(service.list).toHaveBeenCalledWith('user-1', {});
      expect(result.total).toBe(1);
    });
  });

  describe('GET /rides/:rideId', () => {
    it('should return ride detail', async () => {
      await controller.getDetail(mockReq, 'ride-1');

      expect(service.getDetail).toHaveBeenCalledWith('user-1', 'ride-1');
    });

    it('should propagate NotFoundException', async () => {
      service.getDetail.mockRejectedValueOnce(new NotFoundException());

      await expect(controller.getDetail(mockReq, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
