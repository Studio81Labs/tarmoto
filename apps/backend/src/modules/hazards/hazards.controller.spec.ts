/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { HazardsController } from './hazards.controller.js';
import { HazardsService } from './hazards.service.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';

describe('HazardsController', () => {
  let controller: HazardsController;
  let service: jest.Mocked<HazardsService>;
  let configGet: jest.Mock;

  const mockResponse: HazardResponseDto = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    lat: 49.1,
    lng: 16.75,
    hazard_type: 'pothole',
    severity: 'medium',
    note: 'Big pothole',
    photo_url: null,
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
      uploadPhoto: jest.fn().mockResolvedValue({
        photo_url:
          'https://app.tarmoto.test/uploads/hazard-photos/user-1-1700000000000-abc.jpg',
      }),
    };

    configGet = jest.fn().mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HazardsController],
      providers: [
        { provide: HazardsService, useValue: mockService },
        { provide: ConfigService, useValue: { get: configGet } },
        ...authGuardTestProviders,
        // `create` is now `@UseGuards(AuthGuard, FeatureGuard)` — supply the
        // FeatureResolver the guard resolves through (grants all features).
        ...featureGuardTestProviders,
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

  describe('POST /hazards/photos (uploadPhoto)', () => {
    it('should prefer TARMOTO_PUBLIC_BASE_URL over the request-derived host', async () => {
      // Same TLS-terminator scenario as the review-photo controller
      // tests: behind a reverse proxy `req.protocol` reports `http`,
      // so the configured value is the source of truth.
      configGet.mockImplementation((key: string) =>
        key === 'TARMOTO_PUBLIC_BASE_URL'
          ? 'https://api.tarmoto.app'
          : undefined,
      );
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('jpg'),
      } as Express.Multer.File;
      const req = {
        user: { userId: 'user-1' },
        protocol: 'http',
        get: jest.fn().mockReturnValue('internal.tarmoto.svc'),
      } as never;

      await controller.uploadPhoto(req, file);

      expect(service.uploadPhoto).toHaveBeenCalledWith(
        'user-1',
        file,
        'https://api.tarmoto.app',
      );
    });

    it('should fall back to the request-derived host when TARMOTO_PUBLIC_BASE_URL is unset', async () => {
      // Local-dev path: the API serves over plain http on localhost
      // and `isAllowedHazardPhotoUrl` accepts loopback http outside
      // production so the round-trip works.
      configGet.mockReturnValue(undefined);
      const file = {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('jpg'),
      } as Express.Multer.File;
      const req = {
        user: { userId: 'user-1' },
        protocol: 'http',
        get: jest.fn().mockReturnValue('localhost:3000'),
      } as never;

      await controller.uploadPhoto(req, file);

      expect(service.uploadPhoto).toHaveBeenCalledWith(
        'user-1',
        file,
        'http://localhost:3000',
      );
    });

    it('should 500 in production when TARMOTO_PUBLIC_BASE_URL is unset', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      configGet.mockReturnValue(undefined);
      try {
        const file = {
          mimetype: 'image/jpeg',
          buffer: Buffer.from('jpg'),
        } as Express.Multer.File;
        const req = {
          user: { userId: 'user-1' },
          protocol: 'https',
          get: jest.fn().mockReturnValue('api.example.com'),
        } as never;

        await expect(controller.uploadPhoto(req, file)).rejects.toThrow(
          InternalServerErrorException,
        );
        expect(service.uploadPhoto).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previous;
        }
      }
    });

    it('should reject when no file was uploaded', async () => {
      // Multer hands us undefined when the multipart form has no `file`
      // entry; the controller surfaces a 400 itself because the
      // service-level mime-gate never gets a chance to run.
      const req = {
        user: { userId: 'user-1' },
        protocol: 'https',
        get: jest.fn().mockReturnValue('app.tarmoto.test'),
      } as never;

      await expect(controller.uploadPhoto(req, undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(service.uploadPhoto).not.toHaveBeenCalled();
    });
  });
});

describe('HazardsController hazard_reporting feature guard', () => {
  const createHandler = HazardsController.prototype.create;

  function guardContext(
    handler: object,
    user?: { userId: string },
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => HazardsController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('blocks POST /hazards with a 403 when hazard_reporting is force_off', async () => {
    const guard = new FeatureGuard(new Reflector(), {
      resolveForUser: jest.fn().mockResolvedValue({ hazard_reporting: false }),
    } as never);

    await expect(
      guard.canActivate(guardContext(createHandler, { userId: 'user-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows POST /hazards through when hazard_reporting is on', async () => {
    const guard = new FeatureGuard(new Reflector(), {
      resolveForUser: jest.fn().mockResolvedValue({ hazard_reporting: true }),
    } as never);

    await expect(
      guard.canActivate(guardContext(createHandler, { userId: 'user-1' })),
    ).resolves.toBe(true);
  });
});
