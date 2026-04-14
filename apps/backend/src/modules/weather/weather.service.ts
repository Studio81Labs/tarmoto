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
} from './dto/weather.dto.js';
import { haversineKm } from '@tarmoto/shared';

/** Sample points every ~20km along the route */
const ROUTE_SAMPLE_INTERVAL_KM = 20;

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

    // Fetch weather for all sample points in parallel
    const results = await Promise.all(
      samplePoints.map(async (point) => {
        try {
          const data = await this.provider.getCurrentWeather(
            point.lat,
            point.lng,
          );
          return { point, data };
        } catch {
          return null;
        }
      }),
    );

    const points: RouteWeatherPointDto[] = [];
    const alerts: string[] = [];

    for (const result of results) {
      if (!result) continue;

      const response = this.toResponse(result.data);
      points.push({
        ...response,
        lat: result.point.lat,
        lng: result.point.lng,
      });

      // Generate alerts for dangerous conditions
      if (
        result.data.road_condition === 'icy' ||
        result.data.road_condition === 'wet'
      ) {
        alerts.push(
          `${result.data.road_condition === 'icy' ? 'Icy' : 'Wet'} roads near ` +
            `${result.point.lat.toFixed(2)},${result.point.lng.toFixed(2)}: ` +
            `${response.description}`,
        );
      }
      if (result.data.condition === 'storm') {
        alerts.push(
          `Storm warning near ${result.point.lat.toFixed(2)},${result.point.lng.toFixed(2)}`,
        );
      }
      if (result.data.wind_kmh > 60) {
        alerts.push(
          `High wind (${result.data.wind_kmh} km/h) near ` +
            `${result.point.lat.toFixed(2)},${result.point.lng.toFixed(2)}`,
        );
      }
    }

    return {
      points,
      has_alerts: alerts.length > 0,
      alerts,
    };
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
