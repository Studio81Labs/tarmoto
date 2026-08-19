import { Test, TestingModule } from '@nestjs/testing';
import { WeatherService } from './weather.service.js';
import {
  WEATHER_PROVIDER,
  type WeatherProvider,
  type WeatherData,
} from './weather-provider.interface.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

describe('WeatherService', () => {
  let service: WeatherService;
  let provider: jest.Mocked<WeatherProvider>;
  let featureResolver: jest.Mocked<
    Pick<FeatureResolver, 'isSystemSwitchEnabled'>
  >;

  const mockWeather: WeatherData = {
    temperature_c: 14,
    condition: 'clear',
    wind_kmh: 12,
    precipitation_chance: 0,
    road_condition: 'dry',
  };

  beforeEach(async () => {
    provider = {
      getCurrentWeather: jest.fn().mockResolvedValue(mockWeather),
    };
    // Defaults the switch ON so every pre-existing test below is
    // unaffected; the off-case test sets its own mock resolving `false`.
    featureResolver = {
      isSystemSwitchEnabled: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeatherService,
        { provide: WEATHER_PROVIDER, useValue: provider },
        { provide: FeatureResolver, useValue: featureResolver },
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
      expect(result.typed_alerts).toHaveLength(0);
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
      // Each kind shows up exactly once per sampled point so the mobile
      // banner never has to dedupe inside a single response.
      expect(result.typed_alerts.find((a) => a.kind === 'wet')).toMatchObject({
        temperature_c: 14,
        wind_kmh: 75,
      });
      expect(result.typed_alerts.some((a) => a.kind === 'storm')).toBe(true);
      expect(result.typed_alerts.find((a) => a.kind === 'wind')).toMatchObject({
        wind_kmh: 75,
      });
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
      const icy = result.typed_alerts.find((a) => a.kind === 'ice');
      // Ice lifts severity to `critical` because it triggers a voice
      // read-out on the mobile client.
      expect(icy?.severity).toBe('critical');
      expect(icy).toMatchObject({ temperature_c: -3, wind_kmh: 12 });
    });

    it('should expose stable typed alert ids and a distance from route start', async () => {
      provider.getCurrentWeather.mockResolvedValue({
        ...mockWeather,
        condition: 'storm',
      });

      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 49.5, lng: 16.5 },
        { lat: 50.0, lng: 17.0 },
      ];

      const a = await service.getRouteWeather(route);
      const b = await service.getRouteWeather(route);

      // Same input → same alert ids. Lets the mobile dedupe across polls.
      expect(a.typed_alerts.map((x) => x.id).sort()).toEqual(
        b.typed_alerts.map((x) => x.id).sort(),
      );
      // Distances are non-negative and increase along the route — the
      // first sample is always at km 0.
      expect(a.typed_alerts[0]?.distance_km_from_start).toBe(0);
      const distances = a.typed_alerts.map(
        (alert) => alert.distance_km_from_start,
      );
      const sorted = [...distances].sort((x, y) => x - y);
      expect(distances).toEqual(sorted);
    });

    it('should drop wind alerts at exactly the threshold', async () => {
      // The legacy gate was `wind > 60`, so 60 km/h must NOT trigger.
      // Anything above does.
      provider.getCurrentWeather.mockResolvedValue({
        ...mockWeather,
        wind_kmh: 60,
      });

      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 50.0, lng: 17.0 },
      ];

      const result = await service.getRouteWeather(route);
      expect(result.typed_alerts.some((a) => a.kind === 'wind')).toBe(false);
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
      expect(result.typed_alerts).toHaveLength(0);
    });

    it('should return an empty result without hitting the provider when sys_weather_provider is off', async () => {
      featureResolver.isSystemSwitchEnabled.mockResolvedValue(false);

      const route = [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.5, lng: 10.41 },
      ];
      const result = await service.getRouteWeather(route);

      expect(result).toEqual({
        points: [],
        has_alerts: false,
        alerts: [],
        typed_alerts: [],
      });
      expect(provider.getCurrentWeather).not.toHaveBeenCalled();
      expect(featureResolver.isSystemSwitchEnabled).toHaveBeenCalledWith(
        'sys_weather_provider',
      );
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

  describe('distancesAlongRoute', () => {
    it('does not poison later samples when an earlier sample is off-route', () => {
      // Defensive guard: `sampleRoute` always returns route-vertex
      // references so the public method's cursor never has to handle a
      // miss in production. But a future caller that hands in an
      // off-route point shouldn't invalidate every subsequent sample —
      // each one should still resolve to its true distance.
      const route = [
        { lat: 49.0, lng: 16.0 },
        { lat: 49.5, lng: 16.5 },
        { lat: 50.0, lng: 17.0 },
      ];
      const samples = [
        { lat: 49.0, lng: 16.0 }, // matches route[0]
        { lat: 99.0, lng: 99.0 }, // off-route
        { lat: 50.0, lng: 17.0 }, // matches route[2]
      ];

      const distances = service.distancesAlongRoute(route, samples);

      expect(distances[0]).toBe(0);
      expect(distances[1]).toBe(0); // unmatched stays 0
      expect(distances[2]).toBeGreaterThan(0); // last sample still resolves
    });
  });
});
