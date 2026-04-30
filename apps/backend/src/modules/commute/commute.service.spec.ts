/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { CommuteService } from './commute.service.js';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { ROUTING_PROVIDER } from './routing-provider.interface.js';

const mockTransactionManager = {
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  remove: jest.fn().mockResolvedValue(undefined),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => ({
    id: 'route-new',
    created_at: new Date('2026-04-15T10:00:00Z'),
    distance_km: null,
    avg_quality: null,
    is_primary: true,
    ...(data as Record<string, unknown>),
  })),
  save: jest
    .fn()
    .mockImplementation((entity: unknown) => Promise.resolve(entity)),
};

describe('CommuteService', () => {
  let service: CommuteService;
  let routeRepo: Partial<jest.Mocked<Repository<CommuteRoute>>>;
  let rideRepo: Partial<jest.Mocked<Repository<Ride>>>;

  const mockRoute = {
    id: 'route-1',
    user_id: 'user-1',
    name: 'Home → Work',
    origin: { type: 'Point', coordinates: [16.6, 49.2] },
    destination: { type: 'Point', coordinates: [16.75, 49.1] },
    distance_km: 12.5,
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommuteService,
        { provide: getRepositoryToken(CommuteRoute), useValue: routeRepo },
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
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
            getAlternatives: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<CommuteService>(CommuteService);

    // Reset transaction manager mocks between tests
    jest.clearAllMocks();
  });

  describe('listRoutes', () => {
    it('should return user commute routes', async () => {
      const result = await service.listRoutes('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Home → Work');
      expect(result[0].origin).toEqual({ lat: 49.2, lng: 16.6 });
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
    it('should return clear status when no hazards', async () => {
      const result = await service.getStatus('user-1');

      expect(result.status).toBe('clear');
      expect(result.hazard_count).toBe(0);
      expect(result.route.id).toBe('route-1');
    });

    it('should return hazards status when hazards found', async () => {
      routeRepo.query!.mockResolvedValueOnce([{ count: 3 }]);

      const result = await service.getStatus('user-1');

      expect(result.status).toBe('hazards');
      expect(result.hazard_count).toBe(3);
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
      routeRepo.query!.mockResolvedValueOnce([{ count: 0 }]); // primary hazards

      const result = await service.getAlternatives('user-1');

      expect(result.alternatives).toHaveLength(0);
    });
  });
});
