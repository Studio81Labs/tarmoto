import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { featureGuardTestProviders } from '../features/feature-test-providers.js';
import { CommuteController } from './commute.controller.js';
import { CommuteService } from './commute.service.js';

describe('CommuteController', () => {
  let controller: CommuteController;
  let service: jest.Mocked<CommuteService>;

  const mockReq = { user: { userId: 'user-1' } } as never;

  const mockRoute = {
    id: 'route-1',
    name: 'Home → Work',
    origin: { lat: 49.2, lng: 16.6 },
    destination: { lat: 49.1, lng: 16.75 },
    distance_km: 12.5,
    avg_duration_min: 18,
    route_geometry: [
      { lat: 49.2, lng: 16.6 },
      { lat: 49.1, lng: 16.75 },
    ],
    avg_quality: 4.1,
    is_primary: true,
    created_at: '2026-04-14T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      listRoutes: jest.fn().mockResolvedValue([mockRoute]),
      createRoute: jest.fn().mockResolvedValue(mockRoute),
      setPrimaryRoute: jest.fn().mockResolvedValue(mockRoute),
      deleteRoute: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue({
        route: mockRoute,
        hazards: [],
        hazard_count: 0,
        weather: {
          temperature_c: 14,
          condition: 'clear',
          wind_kmh: 8,
          precipitation_chance: 0.1,
          road_condition: 'dry',
          description: '14°C · Dry roads · Wind 8 km/h',
        },
        estimated_time_min: 18,
        route_quality: 4.1,
        status: 'clear',
      }),
      getStats: jest.fn().mockResolvedValue({
        period: 'week',
        total_rides: 0,
        total_km: 0,
        total_time_min: 0,
        avg_duration_min: 0,
        fuel_estimate_l: 0,
        daily_breakdown: [],
        previous_period: {
          total_rides: 0,
          total_km: 0,
          total_time_min: 0,
          avg_duration_min: 0,
          fuel_estimate_l: 0,
        },
      }),
      getAlternatives: jest.fn().mockResolvedValue({
        primary_route: mockRoute,
        primary_hazard_count: 2,
        alternatives: [
          {
            distance_km: 14.2,
            duration_min: 22,
            avg_quality: 4.1,
            hazard_count: 0,
            geometry: [{ lat: 49.2, lng: 16.6 }],
          },
        ],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommuteController],
      providers: [
        { provide: CommuteService, useValue: mockService },
        ...authGuardTestProviders,
        ...featureGuardTestProviders,
      ],
    }).compile();

    controller = module.get<CommuteController>(CommuteController);
    service = module.get(CommuteService);
  });

  it('GET /commute/routes should list routes', async () => {
    const result = await controller.listRoutes(mockReq);
    expect(service.listRoutes).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
  });

  it('POST /commute/routes should create route', async () => {
    const dto = {
      origin: { lat: 49.2, lng: 16.6 },
      destination: { lat: 49.1, lng: 16.75 },
    };
    await controller.createRoute(mockReq, dto);
    expect(service.createRoute).toHaveBeenCalledWith('user-1', dto);
  });

  it('PUT /commute/routes/:id/primary should swap primary route', async () => {
    const result = await controller.setPrimaryRoute(mockReq, 'route-1');
    expect(service.setPrimaryRoute).toHaveBeenCalledWith('user-1', 'route-1');
    expect(result.id).toBe('route-1');
    expect(result.is_primary).toBe(true);
  });

  it('DELETE /commute/routes/:id should delete route', async () => {
    await controller.deleteRoute(mockReq, 'route-1');
    expect(service.deleteRoute).toHaveBeenCalledWith('user-1', 'route-1');
  });

  it('GET /commute/status should return status', async () => {
    const result = await controller.getStatus(mockReq);
    expect(service.getStatus).toHaveBeenCalledWith('user-1');
    expect(result.status).toBe('clear');
  });

  it('GET /commute/alternatives should return alternatives', async () => {
    const result = await controller.getAlternatives(mockReq);
    expect(service.getAlternatives).toHaveBeenCalledWith('user-1');
    expect(result.primary_hazard_count).toBe(2);
    expect(result.alternatives).toHaveLength(1);
  });

  it('GET /commute/stats should return stats', async () => {
    await controller.getStats(mockReq, { period: 'month' });
    expect(service.getStats).toHaveBeenCalledWith('user-1', 'month');
  });
});
