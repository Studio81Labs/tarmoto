/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';
import { TripGeneratorService } from './trip-generator.service.js';

function makeGuardContext(
  handler: object,
  user?: { userId: string },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TripsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TripsController', () => {
  let controller: TripsController;
  let service: jest.Mocked<TripsService>;
  let generator: jest.Mocked<TripGeneratorService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockSummary = {
    id: 'trip-1',
    title: 'Italian Loop',
    region: 'Dolomites',
    num_days: 5,
    status: 'draft',
    member_count: 1,
    created_at: '2026-04-24T10:00:00.000Z',
  };

  const mockDetail = {
    ...mockSummary,
    daily_km_min: 150,
    daily_km_max: 350,
    min_quality: 3,
    road_preference: 'curvy',
    invite_code: 'ABCDEFGH',
    members: [],
    days: [],
  };

  beforeEach(async () => {
    const mockService = {
      list: jest.fn().mockResolvedValue([mockSummary]),
      create: jest.fn().mockResolvedValue(mockDetail),
      getDetail: jest.fn().mockResolvedValue(mockDetail),
      getInvitePreview: jest.fn().mockResolvedValue({ trip_id: 'trip-1' }),
      join: jest.fn().mockResolvedValue(mockDetail),
      update: jest.fn().mockResolvedValue(mockDetail),
      remove: jest.fn().mockResolvedValue(undefined),
      invite: jest.fn().mockResolvedValue(undefined),
      leaveTrip: jest.fn().mockResolvedValue(undefined),
      importFromRoute: jest.fn().mockResolvedValue(mockDetail),
    };

    const mockGenerator = {
      // Echo the caller's `option` (or fall back to 'best-fit') so the
      // controller pass-through assertion actually validates that the
      // DTO's `option` field reaches the generator — not just that the
      // mock returned its hard-coded value.
      generate: jest
        .fn()
        .mockImplementation(
          (
            _userId: string,
            _tripId: string,
            dto: { option?: 'best-fit' | 'scenic' | 'fastest' },
          ) =>
            Promise.resolve({
              trip: mockDetail,
              selected_option: dto.option ?? 'best-fit',
              options: [],
            }),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [
        { provide: TripsService, useValue: mockService },
        { provide: TripGeneratorService, useValue: mockGenerator },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
      ],
    }).compile();

    controller = module.get(TripsController);
    service = module.get(TripsService);
    generator = module.get(TripGeneratorService);
  });

  it('GET /trips delegates to service.list with the caller id', async () => {
    const result = await controller.list(mockReq, { status: 'planned' });
    expect(service.list).toHaveBeenCalledWith('user-1', { status: 'planned' });
    expect(result).toHaveLength(1);
  });

  it('POST /trips creates a trip and returns the detail', async () => {
    const dto = { title: 'Italian Loop', num_days: 5 };
    const result = await controller.create(mockReq, dto);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
    expect(result.invite_code).toBe('ABCDEFGH');
  });

  it('GET /trips/:tripId returns the detail for the caller', async () => {
    const result = await controller.getDetail(mockReq, 'trip-1');
    expect(service.getDetail).toHaveBeenCalledWith('user-1', 'trip-1');
    expect(result.id).toBe('trip-1');
  });

  it('POST /trips/:tripId/join forwards the invite code to the service', async () => {
    const result = await controller.join(mockReq, 'trip-1', {
      invite_code: 'ABCDEFGH',
    });
    expect(service.join).toHaveBeenCalledWith('user-1', 'trip-1', 'ABCDEFGH');
    expect(result.id).toBe('trip-1');
  });

  it('GET /trips/:tripId/invite/:code/preview forwards trip id + code to the service', async () => {
    const result = await controller.getInvitePreview(
      mockReq,
      'trip-1',
      'ABCDEFGH',
    );
    expect(service.getInvitePreview).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      'ABCDEFGH',
    );
    expect(result.trip_id).toBe('trip-1');
  });

  it('PATCH /trips/:tripId forwards the update DTO to the service', async () => {
    const dto = { title: 'Renamed' };
    const result = await controller.update(mockReq, 'trip-1', dto);
    expect(service.update).toHaveBeenCalledWith('user-1', 'trip-1', dto);
    expect(result.id).toBe('trip-1');
  });

  it('DELETE /trips/:tripId delegates to service.remove with the caller id (unconditional by default)', async () => {
    await controller.remove(mockReq, 'trip-1');
    expect(service.remove).toHaveBeenCalledWith('user-1', 'trip-1', false);
  });

  it('DELETE /trips/:tripId?onlyIfDraft=true requests an atomic draft-only delete', async () => {
    await controller.remove(mockReq, 'trip-1', 'true');
    expect(service.remove).toHaveBeenCalledWith('user-1', 'trip-1', true);
  });

  it('POST /trips/:tripId/invite delegates to service.invite and returns queued status', async () => {
    const dto = { email: 'rider@example.com', message: 'Come ride with us!' };
    const result = await controller.invite(mockReq, 'trip-1', dto);
    expect(service.invite).toHaveBeenCalledWith('user-1', 'trip-1', dto);
    expect(result).toEqual({ status: 'queued' });
  });

  it('POST /trips/:tripId/generate forwards the DTO to the generator', async () => {
    const dto = {
      start_location: { lat: 47.0, lng: 11.5 },
      option: 'scenic' as const,
    };
    const result = await controller.generate(mockReq, 'trip-1', dto);
    expect(generator.generate).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      dto,
      expect.any(AbortSignal),
    );
    // Asserts the controller actually plumbed the DTO's `option`
    // through to the generator — the mock echoes whatever option the
    // caller passed, so a regression that drops the field would flip
    // this back to the 'best-fit' default and fail.
    expect(result.selected_option).toBe('scenic');
  });

  it('DELETE /trips/:tripId/members/me delegates to service.leaveTrip', async () => {
    await controller.leaveTrip(mockReq, 'trip-1');
    expect(service.leaveTrip).toHaveBeenCalledWith('user-1', 'trip-1');
  });

  describe('collaborative_trips feature guard', () => {
    const inviteHandler = TripsController.prototype.invite;
    const createHandler = TripsController.prototype.create;

    it('blocks POST /trips/:tripId/invite with a 403 when collaborative_trips is off', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest
          .fn()
          .mockResolvedValue({ collaborative_trips: false }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(inviteHandler, { userId: 'user-1' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows POST /trips/:tripId/invite through when collaborative_trips is on', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest
          .fn()
          .mockResolvedValue({ collaborative_trips: true }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(inviteHandler, { userId: 'user-1' }),
        ),
      ).resolves.toBe(true);
    });

    it('leaves POST /trips (create) unaffected — no @RequireFeature declaration', async () => {
      const resolveForUser = jest
        .fn()
        .mockResolvedValue({ collaborative_trips: false });
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser,
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(createHandler, { userId: 'user-1' }),
        ),
      ).resolves.toBe(true);
      expect(resolveForUser).not.toHaveBeenCalled();
    });
  });

  describe('gpx_import feature guard', () => {
    const importHandler = TripsController.prototype.importRoute;
    const replaceHandler = TripsController.prototype.replaceImportedRoute;

    it('blocks PUT /trips/:tripId/import with a 403 when gpx_import is force_off', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest.fn().mockResolvedValue({ gpx_import: false }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(replaceHandler, { userId: 'user-1' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows PUT /trips/:tripId/import through when gpx_import is on', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest.fn().mockResolvedValue({ gpx_import: true }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(replaceHandler, { userId: 'user-1' }),
        ),
      ).resolves.toBe(true);
    });

    it('blocks POST /trips/import with a 403 when gpx_import is force_off', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest.fn().mockResolvedValue({ gpx_import: false }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(importHandler, { userId: 'user-1' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows POST /trips/import through when gpx_import is on', async () => {
      const guard = new FeatureGuard(new Reflector(), {
        resolveForUser: jest.fn().mockResolvedValue({ gpx_import: true }),
      } as never);

      await expect(
        guard.canActivate(
          makeGuardContext(importHandler, { userId: 'user-1' }),
        ),
      ).resolves.toBe(true);
    });
  });
});
