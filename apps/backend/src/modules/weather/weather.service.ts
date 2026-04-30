import { Injectable, Inject } from '@nestjs/common';
import {
  WEATHER_PROVIDER,
  type WeatherProvider,
  type WeatherData,
} from './weather-provider.interface.js';
import type {
  WeatherResponseDto,
  RouteWeatherResponseDto,
  RouteWeatherPointDto,
  WeatherAlertDto,
} from './dto/weather.dto.js';
import { haversineKm } from '@tarmoto/shared';

/** Sample points every ~20km along the route */
const ROUTE_SAMPLE_INTERVAL_KM = 20;

/** Wind threshold (km/h) that crosses from a regular gust into an alert. */
const WIND_ALERT_THRESHOLD_KMH = 60;

@Injectable()
export class WeatherService {
  constructor(
    @Inject(WEATHER_PROVIDER)
    private readonly provider: WeatherProvider,
  ) {}

  async getCurrentWeather(
    lat: number,
    lng: number,
  ): Promise<WeatherResponseDto> {
    const data = await this.provider.getCurrentWeather(lat, lng);
    return this.toResponse(data);
  }

  async getRouteWeather(
    route: Array<{ lat: number; lng: number }>,
  ): Promise<RouteWeatherResponseDto> {
    // Sample points along the route at regular intervals
    const samplePoints = this.sampleRoute(route, ROUTE_SAMPLE_INTERVAL_KM);
    const sampleDistancesKm = this.distancesAlongRoute(route, samplePoints);

    // Fetch weather for all sample points in parallel
    const results = await Promise.all(
      samplePoints.map(async (point, index) => {
        try {
          const data = await this.provider.getCurrentWeather(
            point.lat,
            point.lng,
          );
          return { point, data, index };
        } catch {
          return null;
        }
      }),
    );

    const points: RouteWeatherPointDto[] = [];
    const alerts: string[] = [];
    const typedAlerts: WeatherAlertDto[] = [];

    for (const result of results) {
      if (!result) continue;

      const response = this.toResponse(result.data);
      points.push({
        ...response,
        lat: result.point.lat,
        lng: result.point.lng,
      });

      const distanceKm = sampleDistancesKm[result.index] ?? 0;
      const latLngLabel = `${result.point.lat.toFixed(2)},${result.point.lng.toFixed(2)}`;

      if (
        result.data.road_condition === 'icy' ||
        result.data.road_condition === 'wet'
      ) {
        const isIcy = result.data.road_condition === 'icy';
        const surfaceLabel = isIcy ? 'Icy' : 'Wet';
        const stringMessage = `${surfaceLabel} roads near ${latLngLabel}: ${response.description}`;
        alerts.push(stringMessage);
        typedAlerts.push({
          id: `${isIcy ? 'ice' : 'wet'}-${result.index}`,
          kind: isIcy ? 'ice' : 'wet',
          // Ice on the road is the single biggest crash risk for a
          // motorcycle — promote it to critical so the rider gets a
          // voice read-out, not just a banner.
          severity: isIcy ? 'critical' : 'info',
          lat: result.point.lat,
          lng: result.point.lng,
          distance_km_from_start: distanceKm,
          title: isIcy ? 'Icy roads ahead' : 'Wet roads ahead',
          message: stringMessage,
        });
      }
      if (result.data.condition === 'storm') {
        const stringMessage = `Storm warning near ${latLngLabel}`;
        alerts.push(stringMessage);
        typedAlerts.push({
          id: `storm-${result.index}`,
          kind: 'storm',
          severity: 'critical',
          lat: result.point.lat,
          lng: result.point.lng,
          distance_km_from_start: distanceKm,
          title: 'Storm warning',
          message: `Severe storm at ${latLngLabel} — consider rerouting or pulling over.`,
        });
      }
      if (result.data.wind_kmh > WIND_ALERT_THRESHOLD_KMH) {
        const stringMessage = `High wind (${result.data.wind_kmh} km/h) near ${latLngLabel}`;
        alerts.push(stringMessage);
        typedAlerts.push({
          id: `wind-${result.index}`,
          kind: 'wind',
          severity: 'warning',
          lat: result.point.lat,
          lng: result.point.lng,
          distance_km_from_start: distanceKm,
          title: 'High wind ahead',
          message: stringMessage,
        });
      }
    }

    return {
      points,
      has_alerts: typedAlerts.length > 0,
      alerts,
      typed_alerts: typedAlerts,
    };
  }

  /**
   * Compute the distance along `route` (km) at which each entry of
   * `samples` first appears, walking the polyline once. Samples are
   * produced by `sampleRoute` so they always sit on a polyline vertex,
   * but in case a sample isn't found (defensive) we return 0 for it.
   */
  distancesAlongRoute(
    route: Array<{ lat: number; lng: number }>,
    samples: Array<{ lat: number; lng: number }>,
  ): number[] {
    if (route.length === 0 || samples.length === 0) return [];

    const cumulative: number[] = new Array<number>(route.length).fill(0);
    for (let i = 1; i < route.length; i++) {
      cumulative[i] =
        cumulative[i - 1] +
        haversineKm(
          route[i - 1].lat,
          route[i - 1].lng,
          route[i].lat,
          route[i].lng,
        );
    }

    let cursor = 0;
    return samples.map((sample) => {
      // Walk forward from the previous sample's position; samples come
      // out of `sampleRoute` in order so we never need to rewind. On a
      // miss we leave `cursor` where it was so a defensive caller that
      // passes an off-route sample doesn't poison every later lookup —
      // each sample gets to scan from the last *successful* match.
      for (let i = cursor; i < route.length; i++) {
        const v = route[i];
        if (v.lat === sample.lat && v.lng === sample.lng) {
          cursor = i;
          return cumulative[i];
        }
      }
      return 0;
    });
  }

  /**
   * Sample points along a route at regular distance intervals.
   */
  sampleRoute(
    route: Array<{ lat: number; lng: number }>,
    intervalKm: number,
  ): Array<{ lat: number; lng: number }> {
    if (route.length === 0) return [];
    if (route.length === 1) return [route[0]];

    const samples: Array<{ lat: number; lng: number }> = [route[0]];
    let accumulated = 0;

    for (let i = 1; i < route.length; i++) {
      const dist = haversineKm(
        route[i - 1].lat,
        route[i - 1].lng,
        route[i].lat,
        route[i].lng,
      );
      accumulated += dist;

      if (accumulated >= intervalKm) {
        samples.push(route[i]);
        accumulated = 0;
      }
    }

    // Always include the last point
    const last = route[route.length - 1];
    if (
      samples.length === 0 ||
      samples[samples.length - 1].lat !== last.lat ||
      samples[samples.length - 1].lng !== last.lng
    ) {
      samples.push(last);
    }

    return samples;
  }

  private toResponse(data: WeatherData): WeatherResponseDto {
    return {
      temperature_c: data.temperature_c,
      condition: data.condition,
      wind_kmh: data.wind_kmh,
      precipitation_chance: data.precipitation_chance,
      road_condition: data.road_condition,
      description:
        `${data.temperature_c}°C · ` +
        `${data.road_condition === 'unknown' ? 'Unknown' : data.road_condition.charAt(0).toUpperCase() + data.road_condition.slice(1)} roads · ` +
        `Wind ${data.wind_kmh} km/h`,
    };
  }
}
