import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PassesController } from './passes.controller.js';
import { PassesService } from './passes.service.js';
import { MountainPassDto } from './dto/passes.dto.js';

const SAMPLE_PASS: MountainPassDto = {
  id: 'pass-1',
  name: 'Stelvio Pass',
  country_code: 'IT',
  region: 'Lombardy',
  lat: 46.5285,
  lng: 10.454,
  elevation_m: 2757,
  typical_open_month: 6,
  typical_close_month: 10,
  status: 'open',
  status_overridden: false,
  notes: null,
  last_updated: '2026-04-18T00:00:00.000Z',
};

describe('PassesController', () => {
  let controller: PassesController;
  let service: jest.Mocked<PassesService>;

  beforeEach(async () => {
    const mockService: Partial<jest.Mocked<PassesService>> = {
      list: jest.fn().mockResolvedValue([SAMPLE_PASS]),
      checkRoute: jest.fn().mockResolvedValue({
        passes: [SAMPLE_PASS],
        closed_count: 0,
        unknown_count: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassesController],
      providers: [
        { provide: PassesService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get<PassesController>(PassesController);
    service = module.get(PassesService);
  });

  it('GET /passes returns the list', async () => {
    const result = await controller.list({});
    expect(service.list).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Stelvio Pass');
  });

  it('GET /passes forwards bbox to the service', async () => {
    await controller.list({ bbox: '5,45,17,49' });
    expect(service.list).toHaveBeenCalledWith(
      '5,45,17,49',
      undefined,
      undefined,
      undefined,
    );
  });

  it('GET /passes forwards for_month to the service', async () => {
    await controller.list({ for_month: 8 });
    expect(service.list).toHaveBeenCalledWith(
      undefined,
      8,
      undefined,
      undefined,
    );
  });

  it('GET /passes forwards pagination to the service', async () => {
    await controller.list({ limit: 200, offset: 400 });
    expect(service.list).toHaveBeenCalledWith(undefined, undefined, 200, 400);
  });

  it('POST /passes/check-route forwards the body and returns counts', async () => {
    const result = await controller.checkRoute({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      buffer_m: 2000,
    });
    expect(service.checkRoute).toHaveBeenCalledWith({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      buffer_m: 2000,
    });
    expect(result.passes).toHaveLength(1);
    expect(result.closed_count).toBe(0);
  });

  it('POST /passes/check-route forwards for_month through unchanged', async () => {
    await controller.checkRoute({
      route: [
        { lat: 46.5, lng: 10.4 },
        { lat: 46.6, lng: 10.5 },
      ],
      for_month: 2,
    });
    expect(service.checkRoute).toHaveBeenCalledWith(
      expect.objectContaining({ for_month: 2 }),
    );
  });

  // Issue #475: previously the whole controller was protected by
  // `AuthGuard`, so unauthenticated callers (the trip planner page on
  // first paint, before the user signs in) got a 401 from `GET /passes`.
  // Pass listing is public reference data, so it now uses
  // `OptionalAuthGuard`. The expensive `POST /passes/check-route` —
  // which runs a PostGIS spatial query over user-supplied coordinates —
  // stays behind `AuthGuard` to avoid exposing unbounded geospatial
  // compute to anonymous traffic. Nest stores `@UseGuards(...)` under
  // the `__guards__` metadata key, on the method (function) for
  // method-level decorators and on the class for class-level ones.
  it('GET /passes uses OptionalAuthGuard so anonymous callers can read pass data', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      PassesController.prototype.list,
    ) as unknown[];
    expect(guards).toBeDefined();
    expect(guards).toContain(OptionalAuthGuard);
    expect(guards).not.toContain(AuthGuard);
  });

  it('POST /passes/check-route stays behind AuthGuard so anonymous callers cannot trigger the spatial query', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      PassesController.prototype.checkRoute,
    ) as unknown[];
    expect(guards).toBeDefined();
    expect(guards).toContain(AuthGuard);
    expect(guards).not.toContain(OptionalAuthGuard);
  });

  it('does not declare a class-level guard so each route opts in explicitly', () => {
    const guards = Reflect.getMetadata('__guards__', PassesController) as
      unknown[] | undefined;
    expect(guards).toBeUndefined();
  });
});
