import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RoutingProvider,
  RouteAlternative,
  RoutingOptions,
} from '../routing-provider.interface.js';

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: {
    coordinates: number[][];
  };
}

interface OsrmResponse {
  code: string;
  routes: OsrmRoute[];
}

/**
 * OSRM routing provider.
 * Uses the OSRM HTTP API for motorcycle/car routing with alternatives.
 * Configure via TARMOTO_OSRM_BASE_URL env var (defaults to public demo).
 *
 * Swap this out by providing a different ROUTING_PROVIDER implementation.
 */
@Injectable()
export class OsrmProvider implements RoutingProvider {
  private readonly logger = new Logger(OsrmProvider.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('TARMOTO_OSRM_BASE_URL') ??
      'https://router.project-osrm.org';
  }

  async getAlternatives(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    maxAlternatives: number,
    options?: RoutingOptions,
  ): Promise<RouteAlternative[]> {
    const coords = `${originLng},${originLat};${destLng},${destLat}`;
    const params = new URLSearchParams({
      alternatives: String(maxAlternatives),
      overview: 'full',
      geometries: 'geojson',
    });
    // OSRM's `driving` profile honours `exclude=motorway`. `toll`
    // exclusion is only available on profiles that have been compiled
    // with toll metadata — the public demo doesn't, but a custom
    // self-hosted OSRM can. We pass it through anyway: an upstream
    // that doesn't recognise the value still routes correctly (it's
    // not strictly invalid), and a self-hosted backend that does
    // recognise it gets the avoidance the rider asked for. Multiple
    // exclusions go in a single comma-separated parameter per the
    // OSRM API spec.
    const exclude: string[] = [];
    if (options?.avoidHighways) exclude.push('motorway');
    if (options?.avoidTolls) exclude.push('toll');
    if (exclude.length > 0) params.set('exclude', exclude.join(','));
    const url = `${this.baseUrl}/route/v1/driving/${coords}?${params.toString()}`;

    const response = await fetch(url);
    if (!response.ok) {
      this.logger.error(
        `OSRM request failed: ${response.status} ${response.statusText}`,
      );
      return [];
    }

    const data = (await response.json()) as OsrmResponse;
    if (data.code !== 'Ok' || !data.routes?.length) {
      return [];
    }

    // OSRM returns the optimal route at index 0, alternatives at 1+.
    // Skip the primary and return only true alternatives, capped at maxAlternatives.
    return data.routes.slice(1, maxAlternatives + 1).map((route) => ({
      distance_km: Math.round((route.distance / 1000) * 100) / 100,
      duration_min: Math.round(route.duration / 60),
      geometry: route.geometry.coordinates.map((c) => ({
        lat: c[1],
        lng: c[0],
      })),
    }));
  }
}
