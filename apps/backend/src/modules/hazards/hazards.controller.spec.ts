/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { HazardsController } from './hazards.controller.js';
import { HazardsService } from './hazards.service.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';

describe('HazardsController', () => {
  let controller: HazardsController;
  let service: jest.Mocked<HazardsService>;

  const mockResponse: HazardResponseDto = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    lat: 49.1,
    lng: 16.75,
    hazard_type: 'pothole',
    severity: 'medium',
    note: 'Big pothole',
    confirmations: 0,
    reporter: 'TestRider',
    road_name: 'D35',
    created_at: '2026-04-13T10:00:00.000Z',
    expires_at: '2026-04-16T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      create: jest.fn().mockResolvedValue(mockResponse),
      findNearby: jest.fn().mockResolvedValue([mockResponse]),
      confirm: jest
        .fn()
        .mockResolvedValue({ ...mockResponse, confirmations: 1 }),
      dismiss: jest.fn().mockResolvedValue(undefined),
      findAlongRoute: jest.fn().mockResolvedValue([mockResponse]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HazardsController],
      providers: [
        { provide: HazardsService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<HazardsController>(HazardsController);
    service = module.get(HazardsService);
  });

  describe('POST /hazards (create)', () => {
    it('should create a hazard and return response', async () => {
      const req = { user: { userId: 'user-1' } } as never;
      const dto = { lat: 49.1, lng: 16.75, hazard_type: 'pothole' as const };

      const result = await controller.create(req, dto);

      expect(service.create).toHaveBeenCalledWith('user-1', dto);
      expect(result.id).toBeDefined();
      expect(result.hazard_type).toBe('pothole');
    });
  });

  describe('GET /hazards (findNearby)', () => {
    it('should return nearby hazards', async () => {
      const query = { lat: 49.1, lng: 16.75 };

      const result = await controller.findNearby(query);

      expect(service.findNearby).toHaveBeenCalledWith(query);
      expect(result).toHaveLength(1);
      expect(result[0].hazard_type).toBe('pothole');
    });

    it('should pass radius and types to service', async () => {
      const query = {
        lat: 49.1,
        lng: 16.75,
        radius: 5000,
        types: 'pothole,gravel',
      };

      await controller.findNearby(query);

      expect(service.findNearby).toHaveBeenCalledWith(query);
    });
  });

  describe('POST /hazards/:id/confirm', () => {
    it('should confirm and return updated hazard', async () => {
      const req = { user: { userId: 'user-1' } } as never;
      const result = await controller.confirm(req, mockResponse.id);

      expect(service.confirm).toHaveBeenCalledWith(mockResponse.id, 'user-1');
      expect(result.confirmations).toBe(1);
    });
  });

  describe('POST /hazards/:id/dismiss', () => {
    it('should dismiss the hazard', async () => {
      await controller.dismiss(mockResponse.id);

      expect(service.dismiss).toHaveBeenCalledWith(mockResponse.id);
    });

    it('should propagate NotFoundException', async () => {
      service.dismiss.mockRejectedValueOnce(
        new NotFoundException('Hazard not found or already expired'),
      );

      await expect(controller.dismiss('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /hazards/route (findAlongRoute)', () => {
    it('should return hazards along route', async () => {
      const dto = {
        route: [
          { lat: 49.1, lng: 16.75 },
          { lat: 49.2, lng: 16.85 },
        ],
      };

      const result = await controller.findAlongRoute(dto);

      expect(service.findAlongRoute).toHaveBeenCalledWith(dto);
      expect(result).toHaveLength(1);
    });

    it('should pass custom buffer to service', async () => {
      const dto = {
        route: [
          { lat: 49.1, lng: 16.75 },
          { lat: 49.2, lng: 16.85 },
        ],
        buffer_m: 500,
      };

      await controller.findAlongRoute(dto);

      expect(service.findAlongRoute).toHaveBeenCalledWith(dto);
    });
  });
});
