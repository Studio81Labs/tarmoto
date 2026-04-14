/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { WeatherService } from './weather.service.js';
import {
  WEATHER_PROVIDER,
  type WeatherProvider,
  type WeatherData,
} from './weather-provider.interface.js';

describe('WeatherService', () => {
  let service: WeatherService;
  let provider: jest.Mocked<WeatherProvider>;

  const mockWeather: WeatherData = {
    temperature_c: 14,
    condition: 'clear',
    wind_kmh: 12,
    precipitation_chance: 0,
    road_condition: 'dry',
    provider_description: 'clear sky',
  };

  beforeEach(async () => {
    provider = {
      getCurrentWeather: jest.fn().mockResolvedValue(mockWeather),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeatherService,
        { provide: WEATHER_PROVIDER, useValue: provider },
      ],
    }).compile();

    service = module.get<WeatherService>(WeatherService);
  });

  describe('getCurrentWeather', () => {
    it('should return formatted weather response', async () => {
      const result = await service.getCurrentWeather(49.1, 16.75);

      expect(provider.getCurrentWeather).toHaveBeenCalledWith(49.1, 16.75);
      expect(result.temperature_c).toBe(14);
      expect(result.condition).toBe('clear');
      expect(result.road_condition).toBe('dry');
      expect(result.description).toContain('14°C');
      expect(result.description).toContain('Dry roads');
      expect(result.description).toContain('12 km/h');
    });
  });

  describe('getRouteWeather', () => {
    it('should return weather at sampled points along route', async () => {
      // ~100km route with 3 points
      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 49.5, lng: 16.5 },
        { lat: 50.0, lng: 17.0 },
      ];

      const result = await service.getRouteWeather(route);

      expect(result.points.length).toBeGreaterThanOrEqual(2);
      expect(result.has_alerts).toBe(false);
      expect(result.alerts).toHaveLength(0);
    });

    it('should generate alerts for dangerous conditions', async () => {
      provider.getCurrentWeather.mockResolvedValue({
        ...mockWeather,
        condition: 'storm',
        road_condition: 'wet',
        wind_kmh: 75,
      });

      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 50.0, lng: 17.0 },
      ];

      const result = await service.getRouteWeather(route);

      expect(result.has_alerts).toBe(true);
      expect(result.alerts.some((a) => a.includes('Wet roads'))).toBe(true);
      expect(result.alerts.some((a) => a.includes('Storm'))).toBe(true);
      expect(result.alerts.some((a) => a.includes('High wind'))).toBe(true);
    });

    it('should generate icy road alert', async () => {
      provider.getCurrentWeather.mockResolvedValue({
        ...mockWeather,
        condition: 'snow',
        road_condition: 'icy',
        temperature_c: -3,
      });

      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 50.0, lng: 17.0 },
      ];

      const result = await service.getRouteWeather(route);

      expect(result.has_alerts).toBe(true);
      expect(result.alerts.some((a) => a.includes('Icy'))).toBe(true);
    });

    it('should handle provider errors gracefully', async () => {
      provider.getCurrentWeather.mockRejectedValue(new Error('API error'));

      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 50.0, lng: 17.0 },
      ];

      const result = await service.getRouteWeather(route);

      expect(result.points).toHaveLength(0);
      expect(result.has_alerts).toBe(false);
    });
  });

  describe('sampleRoute', () => {
    it('should return start and end for short route', () => {
      const route = [
        { lat: 49.1, lng: 16.75 },
        { lat: 49.101, lng: 16.751 },
      ];

      const samples = service.sampleRoute(route, 20);

      expect(samples.length).toBe(2);
      expect(samples[0]).toEqual(route[0]);
      expect(samples[1]).toEqual(route[1]);
    });

    it('should sample at intervals for long route', () => {
      // ~111km route (1 degree latitude)
      const route = [];
      for (let i = 0; i <= 100; i++) {
        route.push({ lat: 49.0 + i * 0.01, lng: 16.0 });
      }

      const samples = service.sampleRoute(route, 20);

      // ~111km / 20km = ~5 samples + start + end
      expect(samples.length).toBeGreaterThanOrEqual(5);
      expect(samples.length).toBeLessThanOrEqual(10);
    });

    it('should handle empty route', () => {
      expect(service.sampleRoute([], 20)).toEqual([]);
    });

    it('should handle single point', () => {
      const route = [{ lat: 49.1, lng: 16.75 }];
      expect(service.sampleRoute(route, 20)).toEqual(route);
    });
  });
});
