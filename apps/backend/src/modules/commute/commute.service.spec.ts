/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { CommuteService } from './commute.service.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardsService } from '../hazards/hazards.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { ROUTING_PROVIDER } from './routing-provider.interface.js';

const mockTransactionManager = {
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  remove: jest.fn().mockResolvedValue(undefined),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => ({
    id: 'route-new',
    created_at: new Date('2026-04-15T10:00:00Z'),
    distance_km: null,
    avg_duration: null,
    avg_quality: null,
    route_geom: null,
    is_primary: true,
    ...(data as Record<string, unknown>),
  })),
  save: jest
    .fn()
    .mockImplementation((entity: unknown) => Promise.resolve(entity)),
};

const mockWeather = {
  temperature_c: 14,
  condition: 'clear' as const,
  wind_kmh: 8,
  precipitation_chance: 0.1,
  road_condition: 'dry' as const,
  description: '14°C · Dry roads · Wind 8 km/h',
};

describe('CommuteService', () => {
  let service: CommuteService;
  let routeRepo: Partial<jest.Mocked<Repository<CommuteRoute>>>;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;
  let hazardsService: jest.Mocked<Pick<HazardsService, 'findAlongRoute'>>;
  let weatherService: jest.Mocked<Pick<WeatherService, 'getCurrentWeather'>>;

  const mockRoute = {
    id: 'route-1',
    user_id: 'user-1',
    name: 'Home → Work',
    origin: { type: 'Point', coordinates: [16.6, 49.2] },
    destination: { type: 'Point', coordinates: [16.75, 49.1] },
    route_geom: {
      type: 'LineString',
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.15],
        [16.75, 49.1],
      ],
    },
    distance_km: 12.5,
    avg_duration: '00:18:00',
    avg_quality: 4.1,
    is_primary: true,
    created_at: new Date('2026-04-14T10:00:00Z'),
  } as unknown as CommuteRoute;

  beforeEach(async () => {
    routeRepo = {
      find: jest.fn().mockResolvedValue([mockRoute]),
      findOne: jest.fn().mockResolvedValue(mockRoute),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...mockRoute, ...data })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([{ count: 0 }]),
    };
    rideRepo = {
      query: jest.fn().mockResolvedValue([]),
    };
    hazardsService = {
      findAlongRoute: jest.fn().mockResolvedValue([]),
    };
    weatherService = {
      getCurrentWeather: jest.fn().mockResolvedValue(mockWeather),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommuteService,
        { provide: getRepositoryToken(CommuteRoute), useValue: routeRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: HazardsService, useValue: hazardsService },
        { provide: WeatherService, useValue: weatherService },
        {
          provide: DataSource,
          useValue: {
            transaction: jest
              .fn()
              .mockImplementation(
                (
                  cb: (
                    manager: typeof mockTransactionManager,
                  ) => Promise<unknown>,
                ) => cb(mockTransactionManager),
              ),
          },
        },
        {
          provide: ROUTING_PROVIDER,
          useValue: {
            // Default: routing returns one resolved candidate so cache-fill
            // paths produce geometry. Tests that exercise routing failures
            // override this per-test.
            getAlternatives: jest.fn().mockResolvedValue([
              {
                distance_km: 12.5,
                duration_min: 18,
                geometry: [
                  { lat: 49.2, lng: 16.6 },
                  { lat: 49.15, lng: 16.7 },
                  { lat: 49.1, lng: 16.75 },
                ],
              },
            ]),
          },
        },
      ],
    }).compile();

    service = module.get<CommuteService>(CommuteService);

    // Reset transaction manager mocks between tests
    jest.clearAllMocks();
  });

  describe('listRoutes', () => {
    it('should return user commute routes with cached geometry and duration surfaced', async () => {
      const result = await service.listRoutes('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Home → Work');
      expect(result[0].origin).toEqual({ lat: 49.2, lng: 16.6 });
      expect(result[0].avg_duration_min).toBe(18);
      expect(result[0].route_geometry).toEqual([
        { lat: 49.2, lng: 16.6 },
        { lat: 49.15, lng: 16.7 },
        { lat: 49.1, lng: 16.75 },
      ]);
    });

    it('lazily backfills the primary route when its cache fields are null', async () => {
      // Legacy row: saved before route_geom/distance_km/avg_duration were
      // populated. The list call should resolve it via the routing
      // provider, persist the result, and surface populated fields in the
      // response.
      const legacy = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
        is_primary: true,
      };
      routeRepo.find!.mockResolvedValueOnce([legacy] as never);

      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;

      const result = await service.listRoutes('user-1');

      expect(routingProvider.getAlternatives).toHaveBeenCalledWith(
        49.2,
        16.6,
        49.1,
        16.75,
        1,
        { includePrimary: true },
      );
      // The persisted UPDATE goes through routeRepo.query.
      expect(routeRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE commute_routes'),
        expect.arrayContaining([
          expect.stringContaining('LINESTRING'),
          12.5,
          18,
          'route-1',
        ]),
      );
      expect(result[0].route_geometry).toEqual([
        { lat: 49.2, lng: 16.6 },
        { lat: 49.15, lng: 16.7 },
        { lat: 49.1, lng: 16.75 },
      ]);
      expect(result[0].distance_km).toBe(12.5);
      expect(result[0].avg_duration_min).toBe(18);
    });

    it('skips backfill when no saved routes are primary', async () => {
      // listRoutes only fills the primary; a non-primary saved row with
      // missing cache fields stays null until the rider promotes it.
      const nonPrimary = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
        is_primary: false,
      };
      routeRepo.find!.mockResolvedValueOnce([nonPrimary] as never);

      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;

      const result = await service.listRoutes('user-1');

      expect(routingProvider.getAlternatives).not.toHaveBeenCalled();
      expect(result[0].route_geometry).toBeNull();
      expect(result[0].distance_km).toBeNull();
      expect(result[0].avg_duration_min).toBeNull();
    });

    it('serves a route with null cache fields when the routing provider fails', async () => {
      // Best-effort backfill: a transient routing-provider outage must
      // not block the list response. The fields stay null and the next
      // list call retries.
      const legacy = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
        is_primary: true,
      };
      routeRepo.find!.mockResolvedValueOnce([legacy] as never);
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockRejectedValueOnce(
        new Error('OSRM down'),
      );

      const result = await service.listRoutes('user-1');

      expect(result[0].route_geometry).toBeNull();
      expect(result[0].distance_km).toBeNull();
      expect(result[0].avg_duration_min).toBeNull();
      expect(routeRepo.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE commute_routes'),
        expect.anything(),
      );
    });
  });

  describe('createRoute', () => {
    it('should create a commute route with Point geometry via transaction', async () => {
      await service.createRoute('user-1', {
        name: 'Daily commute',
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      expect(mockTransactionManager.create).toHaveBeenCalledWith(
        CommuteRoute,
        expect.objectContaining({
          user_id: 'user-1',
          name: 'Daily commute',
          origin: { type: 'Point', coordinates: [16.6, 49.2] },
          destination: { type: 'Point', coordinates: [16.75, 49.1] },
        }),
      );
    });

    it('should unset primary on existing routes atomically', async () => {
      await service.createRoute('user-1', {
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      expect(mockTransactionManager.update).toHaveBeenCalledWith(
        CommuteRoute,
        { user_id: 'user-1', is_primary: true },
        { is_primary: false },
      );
      expect(mockTransactionManager.create).toHaveBeenCalledWith(
        CommuteRoute,
        expect.objectContaining({ is_primary: true }),
      );
    });

    it('should default name to "Default"', async () => {
      await service.createRoute('user-1', {
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      expect(mockTransactionManager.create).toHaveBeenCalledWith(
        CommuteRoute,
        expect.objectContaining({ name: 'Default' }),
      );
    });

    it('resolves and persists the route polyline + duration after insert', async () => {
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;

      const result = await service.createRoute('user-1', {
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      expect(routingProvider.getAlternatives).toHaveBeenCalledWith(
        49.2,
        16.6,
        49.1,
        16.75,
        1,
        { includePrimary: true },
      );
      expect(routeRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE commute_routes'),
        expect.arrayContaining([
          expect.stringContaining('LINESTRING'),
          12.5,
          18,
          'route-new',
        ]),
      );
      expect(result.route_geometry).toEqual([
        { lat: 49.2, lng: 16.6 },
        { lat: 49.15, lng: 16.7 },
        { lat: 49.1, lng: 16.75 },
      ]);
      expect(result.avg_duration_min).toBe(18);
      expect(result.distance_km).toBe(12.5);
    });

    it('rounds fractional duration_min before passing it to make_interval', async () => {
      // Regression guard: postgres' `make_interval(mins => …)` expects
      // an `int`. If a `RoutingProvider` returns a non-integer minute
      // count, the pg driver would send "18.5" as text, the query
      // would fail to parse, and the catch would swallow it — pinning
      // the cache permanently null on every retry. Force a fractional
      // duration and assert the SQL parameter is the rounded int.
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockResolvedValueOnce([
        {
          distance_km: 12.5,
          duration_min: 18.5,
          geometry: [
            { lat: 49.2, lng: 16.6 },
            { lat: 49.1, lng: 16.75 },
          ],
        },
      ]);

      const result = await service.createRoute('user-1', {
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      const updateCall = routeRepo.query!.mock.calls.find((call) =>
        String(call[0]).includes('UPDATE commute_routes'),
      );
      expect(updateCall).toBeDefined();
      // make_interval bind: [wkt, distance_km, duration_min, id].
      const params = updateCall![1] as unknown[];
      expect(params[2]).toBe(19);
      expect(Number.isInteger(params[2])).toBe(true);
      // In-memory mirror agrees with the persisted value.
      expect(result.avg_duration_min).toBe(19);
    });

    it('still returns the saved route when the routing provider fails', async () => {
      // Resolution is best-effort: a transient OSRM failure shouldn't
      // reject the create — we keep the row, log, and let lazy backfill
      // on subsequent reads retry.
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockRejectedValueOnce(
        new Error('OSRM unreachable'),
      );

      const result = await service.createRoute('user-1', {
        origin: { lat: 49.2, lng: 16.6 },
        destination: { lat: 49.1, lng: 16.75 },
      });

      expect(result.id).toBe('route-new');
      expect(result.route_geometry).toBeNull();
      expect(result.avg_duration_min).toBeNull();
      expect(result.distance_km).toBeNull();
      expect(routeRepo.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE commute_routes'),
        expect.anything(),
      );
    });
  });

  describe('setPrimaryRoute', () => {
    it('atomically swaps primary flag inside the transaction', async () => {
      // Target is currently non-primary so the swap actually performs the
      // unset+save. The order matters: unset must run before the save so
      // a concurrent reader can never see two primary routes.
      mockTransactionManager.findOne.mockResolvedValueOnce({
        ...mockRoute,
        id: 'route-2',
        is_primary: false,
      });

      const result = await service.setPrimaryRoute('user-1', 'route-2');

      expect(mockTransactionManager.update).toHaveBeenCalledWith(
        CommuteRoute,
        { user_id: 'user-1', is_primary: true },
        { is_primary: false },
      );
      expect(mockTransactionManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'route-2', is_primary: true }),
      );
      expect(result.id).toBe('route-2');
      expect(result.is_primary).toBe(true);
    });

    it('skips writes when the target is already primary', async () => {
      mockTransactionManager.findOne.mockResolvedValueOnce({
        ...mockRoute,
        is_primary: true,
      });

      await service.setPrimaryRoute('user-1', 'route-1');

      expect(mockTransactionManager.update).not.toHaveBeenCalled();
      expect(mockTransactionManager.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for missing route', async () => {
      mockTransactionManager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.setPrimaryRoute('user-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteRoute', () => {
    it('should delete a route via transaction', async () => {
      // findOne inside transaction returns the route
      mockTransactionManager.findOne.mockResolvedValueOnce(mockRoute);

      await service.deleteRoute('user-1', 'route-1');

      expect(mockTransactionManager.remove).toHaveBeenCalledWith(mockRoute);
    });

    it('should promote next route when deleting primary', async () => {
      const nextRoute = {
        ...mockRoute,
        id: 'route-2',
        is_primary: false,
      };
      // First findOne: the route to delete (primary)
      mockTransactionManager.findOne.mockResolvedValueOnce(mockRoute);
      // Second findOne: the next route to promote
      mockTransactionManager.findOne.mockResolvedValueOnce(nextRoute);

      await service.deleteRoute('user-1', 'route-1');

      expect(mockTransactionManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'route-2', is_primary: true }),
      );
    });

    it('should not promote when deleting non-primary route', async () => {
      mockTransactionManager.findOne.mockResolvedValueOnce({
        ...mockRoute,
        is_primary: false,
      });

      await service.deleteRoute('user-1', 'route-1');

      expect(mockTransactionManager.save).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing route', async () => {
      mockTransactionManager.findOne.mockResolvedValueOnce(null);

      await expect(service.deleteRoute('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getStatus', () => {
    it('should return clear status, weather, and estimated time when no hazards', async () => {
      const result = await service.getStatus('user-1');

      expect(result.status).toBe('clear');
      expect(result.hazard_count).toBe(0);
      expect(result.hazards).toEqual([]);
      expect(result.weather).toEqual(mockWeather);
      expect(result.estimated_time_min).toBe(18);
      expect(result.route_quality).toBe(4.1);
      expect(result.route.id).toBe('route-1');
      expect(result.route.avg_duration_min).toBe(18);
      expect(result.route.route_geometry).toHaveLength(3);
    });

    it('queries hazards along the cached route polyline (not the straight line)', async () => {
      // Pre-#353 the legacy `countHazardsNearLine` always used a
      // straight origin → destination line. The combined endpoint
      // should follow the actual road shape when the cache is
      // populated so the hazard list matches what the rider will
      // actually pass through.
      await service.getStatus('user-1');

      expect(hazardsService.findAlongRoute).toHaveBeenCalledWith({
        route: [
          { lat: 49.2, lng: 16.6 },
          { lat: 49.15, lng: 16.7 },
          { lat: 49.1, lng: 16.75 },
        ],
        buffer_m: 500,
      });
    });

    it('falls back to origin → destination line when route_geom is missing', async () => {
      // After cache-fill resolves below, but the routing provider
      // returns no geometry, the service still needs hazards. We
      // stub a no-op cache-fill (provider returns nothing) so the
      // fallback line is exercised.
      const legacy = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
      };
      routeRepo.findOne!.mockResolvedValueOnce(legacy);
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockResolvedValueOnce([]);

      await service.getStatus('user-1');

      expect(hazardsService.findAlongRoute).toHaveBeenCalledWith({
        route: [
          { lat: 49.2, lng: 16.6 },
          { lat: 49.1, lng: 16.75 },
        ],
        buffer_m: 500,
      });
    });

    it('lazily backfills the cache when the primary route lacks geometry', async () => {
      const legacy = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
      };
      routeRepo.findOne!.mockResolvedValueOnce(legacy);
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;

      const result = await service.getStatus('user-1');

      expect(routingProvider.getAlternatives).toHaveBeenCalledWith(
        49.2,
        16.6,
        49.1,
        16.75,
        1,
        { includePrimary: true },
      );
      expect(result.route.route_geometry).toHaveLength(3);
      expect(result.route.avg_duration_min).toBe(18);
      expect(result.route.distance_km).toBe(12.5);
      expect(result.estimated_time_min).toBe(18);
    });

    it('returns hazards status with the inline list when hazards are found', async () => {
      const hazardFixture = {
        id: 'h-1',
        lat: 49.15,
        lng: 16.7,
        hazard_type: 'pothole' as const,
        severity: 'medium' as const,
        note: null,
        photo_url: null,
        confirmations: 0,
        reporter: 'Adam',
        road_name: 'M Highway',
        created_at: '2026-04-30T10:00:00.000Z',
        expires_at: '2026-05-01T10:00:00.000Z',
      };
      hazardsService.findAlongRoute.mockResolvedValueOnce([hazardFixture]);

      const result = await service.getStatus('user-1');

      expect(result.status).toBe('hazards');
      expect(result.hazard_count).toBe(1);
      expect(result.hazards).toEqual([hazardFixture]);
    });

    it('samples weather at the route origin', async () => {
      await service.getStatus('user-1');

      expect(weatherService.getCurrentWeather).toHaveBeenCalledWith(49.2, 16.6);
    });

    it('returns null weather when the provider fails so the rest of the response still reaches the client', async () => {
      // Best-effort weather: a transient OpenWeatherMap outage shouldn't
      // blank the whole commute card. The route, hazards, and quality
      // fields are still served, and `weather` falls through to null.
      weatherService.getCurrentWeather.mockRejectedValueOnce(
        new Error('OpenWeatherMap unreachable'),
      );

      const result = await service.getStatus('user-1');

      expect(result.weather).toBeNull();
      expect(result.route.id).toBe('route-1');
      expect(result.estimated_time_min).toBe(18);
    });

    it('should throw NotFoundException when no primary route', async () => {
      routeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getStatus('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getStats', () => {
    it('should return weekly stats with daily breakdown and prior-week totals', async () => {
      // First call: current period rows; second call: aggregated prior
      // period row. The service issues both queries in parallel.
      rideRepo.query!.mockResolvedValueOnce([
        { date: '2026-04-14', rides: 2, km: 25, duration_min: 36 },
        { date: '2026-04-13', rides: 2, km: 25, duration_min: 34 },
      ]);
      rideRepo.query!.mockResolvedValueOnce([
        { rides: 3, km: 30, duration_min: 60 },
      ]);

      const result = await service.getStats('user-1', 'week');

      expect(result.period).toBe('week');
      expect(result.total_rides).toBe(4);
      expect(result.total_km).toBe(50);
      expect(result.total_time_min).toBe(70);
      expect(result.avg_duration_min).toBe(18);
      expect(result.fuel_estimate_l).toBe(2.5);
      expect(result.daily_breakdown).toHaveLength(2);
      expect(result.previous_period).toEqual({
        total_rides: 3,
        total_km: 30,
        total_time_min: 60,
        avg_duration_min: 20,
        fuel_estimate_l: 1.5,
      });
    });

    it('should return empty stats when no commute rides', async () => {
      // Both periods empty: the prior-period query returns a single zeroed
      // aggregate row (COUNT/SUM with no matches), which the service
      // collapses to an all-zero `previous_period`.
      rideRepo.query!.mockResolvedValueOnce([]);
      rideRepo.query!.mockResolvedValueOnce([
        { rides: 0, km: 0, duration_min: 0 },
      ]);

      const result = await service.getStats('user-1', 'week');

      expect(result.total_rides).toBe(0);
      expect(result.total_km).toBe(0);
      expect(result.fuel_estimate_l).toBe(0);
      expect(result.previous_period.total_rides).toBe(0);
      expect(result.previous_period.total_km).toBe(0);
      expect(result.previous_period.fuel_estimate_l).toBe(0);
    });

    it('issues a well-formed SQL INTERVAL for the prior window', async () => {
      // Regression guard for a bug where the prior window was computed
      // by string-concatenating " 2" onto "7 days", yielding the literal
      // `INTERVAL '7 days 2'`. Postgres parses unit-less tokens as
      // seconds, so that literal collapsed to `7 days + 2 seconds` and
      // the trend was effectively always 0. The fix builds the doubled
      // boundary explicitly from `intervalDays * 2`.
      rideRepo.query!.mockResolvedValueOnce([]);
      rideRepo.query!.mockResolvedValueOnce([
        { rides: 0, km: 0, duration_min: 0 },
      ]);

      await service.getStats('user-1', 'week');

      const calls = rideRepo.query!.mock.calls;
      expect(calls).toHaveLength(2);
      const currentSql = String(calls[0][0]);
      const priorSql = String(calls[1][0]);
      expect(currentSql).toContain("INTERVAL '7 days'");
      expect(currentSql).not.toContain("INTERVAL '7 days 2'");
      expect(priorSql).toContain("INTERVAL '14 days'");
      expect(priorSql).toContain("INTERVAL '7 days'");
      expect(priorSql).not.toContain("INTERVAL '7 days 2'");
    });

    it('doubles the boundary for the month period too', async () => {
      rideRepo.query!.mockResolvedValueOnce([]);
      rideRepo.query!.mockResolvedValueOnce([
        { rides: 0, km: 0, duration_min: 0 },
      ]);

      await service.getStats('user-1', 'month');

      const priorSql = String(rideRepo.query!.mock.calls[1][0]);
      expect(priorSql).toContain("INTERVAL '60 days'");
      expect(priorSql).toContain("INTERVAL '30 days'");
    });
  });

  describe('getAlternatives', () => {
    it('should return alternatives with hazard and quality enrichment', async () => {
      // Mock routing provider with alternatives
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockResolvedValueOnce([
        {
          distance_km: 14.2,
          duration_min: 22,
          geometry: [
            { lat: 49.2, lng: 16.6 },
            { lat: 49.15, lng: 16.7 },
            { lat: 49.1, lng: 16.75 },
          ],
        },
      ]);

      // Mock hazard counts (primary + alternative)
      routeRepo.query!.mockResolvedValueOnce([{ count: 2 }]); // primary hazards
      routeRepo.query!.mockResolvedValueOnce([{ count: 0 }]); // alt hazards
      routeRepo.query!.mockResolvedValueOnce([{ avg_quality: 4.1 }]); // alt quality

      const result = await service.getAlternatives('user-1');

      expect(result.primary_route.id).toBe('route-1');
      expect(result.primary_hazard_count).toBe(2);
      expect(result.alternatives).toHaveLength(1);
      expect(result.alternatives[0].distance_km).toBe(14.2);
      expect(result.alternatives[0].hazard_count).toBe(0);
      expect(result.alternatives[0].avg_quality).toBe(4.1);
    });

    it('should throw NotFoundException when no primary route', async () => {
      routeRepo.findOne!.mockResolvedValueOnce(null);

      await expect(service.getAlternatives('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return empty alternatives when routing provider returns none', async () => {
      // The default mock returns one route so cache-fill paths produce
      // geometry; for the "no alternatives" assertion we drop both the
      // cache-fill candidate and the alternatives candidate.
      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;
      routingProvider.getAlternatives.mockResolvedValue([]);
      routeRepo.query!.mockResolvedValueOnce([{ count: 0 }]); // primary hazards

      const result = await service.getAlternatives('user-1');

      expect(result.alternatives).toHaveLength(0);
    });

    it('lazily backfills the primary route cache when geometry is missing', async () => {
      // Legacy primary lacks the cache fields, so getAlternatives should
      // resolve it once before fanning out to the alternatives lookup.
      // The first routing-provider call is the cache-fill; the second is
      // the alternatives query that always runs.
      const legacy = {
        ...mockRoute,
        route_geom: null,
        distance_km: null,
        avg_duration: null,
      };
      routeRepo.findOne!.mockResolvedValueOnce(legacy);
      routeRepo.query!.mockResolvedValueOnce([{ count: 0 }]); // primary hazards

      const routingProvider = service['routingProvider'] as jest.Mocked<{
        getAlternatives: jest.Mock;
      }>;

      const result = await service.getAlternatives('user-1');

      expect(routingProvider.getAlternatives).toHaveBeenNthCalledWith(
        1,
        49.2,
        16.6,
        49.1,
        16.75,
        1,
        { includePrimary: true },
      );
      expect(result.primary_route.route_geometry).toHaveLength(3);
      expect(result.primary_route.avg_duration_min).toBe(18);
      expect(result.primary_route.distance_km).toBe(12.5);
    });
  });

  describe('parseIntervalMinutes', () => {
    // The parser sees both shapes at runtime: pg's default returns a
    // PostgresInterval object, but TypeORM types the column as string,
    // and tests construct strings. The mapper needs to accept either.

    it('parses HH:MM:SS strings', () => {
      const fn = service['parseIntervalMinutes'].bind(service);
      expect(fn('00:18:00')).toBe(18);
      expect(fn('01:30:30')).toBe(91);
    });

    it('parses N days HH:MM:SS strings', () => {
      const fn = service['parseIntervalMinutes'].bind(service);
      expect(fn('1 day 02:00:00')).toBe(1560);
    });

    it('parses pg PostgresInterval objects', () => {
      const fn = service['parseIntervalMinutes'].bind(service);
      expect(fn({ hours: 0, minutes: 18, seconds: 0 })).toBe(18);
      expect(fn({ hours: 1, minutes: 30 })).toBe(90);
    });

    it('returns null for null and unparseable input', () => {
      const fn = service['parseIntervalMinutes'].bind(service);
      expect(fn(null)).toBeNull();
      expect(fn('not an interval')).toBeNull();
    });
  });
});
