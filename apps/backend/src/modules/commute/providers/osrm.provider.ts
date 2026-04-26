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
    // OSRM's `driving` profile honours `exclude=motorway`. `toll`
    // exclusion is only available on profiles that have been compiled
    // with toll metadata — the public demo doesn't, but a custom
    // self-hosted OSRM can. We pass it through anyway: an upstream
    // that doesn't recognise the value still routes correctly (it's
    // not strictly invalid), and a self-hosted backend that does
    // recognise it gets the avoidance the rider asked for.
    //
    // Build the query string manually rather than via URLSearchParams:
    // the WHATWG URL spec percent-encodes commas, producing
    // `exclude=motorway%2Ctoll` — OSRM's custom HTTP handler does not
    // reliably decode `%2C` back to `,`, so the exclude parameter
    // would be silently ignored. The values here are all known-safe
    // (numbers and a fixed enum of OSRM exclusion classes), so direct
    // concatenation is unambiguous.
    const queryParts: string[] = [
      `alternatives=${maxAlternatives}`,
      `overview=full`,
      `geometries=geojson`,
    ];
    const exclude: string[] = [];
    if (options?.avoidHighways) exclude.push('motorway');
    if (options?.avoidTolls) exclude.push('toll');
    if (exclude.length > 0) {
      queryParts.push(`exclude=${exclude.join(',')}`);
    }
    const url = `${this.baseUrl}/route/v1/driving/${coords}?${queryParts.join('&')}`;

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
    // The commute module persists its own primary, so by default we
    // skip index 0 and surface only the true alternatives. The trip
    // generator (US-7) opts in via `includePrimary` because it wants
    // every candidate scored equally — otherwise a leg where OSRM
    // found only one route would yield an empty set and fall through
    // to a synthetic 0 km stub day.
    const start = options?.includePrimary ? 0 : 1;
    return data.routes.slice(start, start + maxAlternatives).map((route) => ({
      distance_km: Math.round((route.distance / 1000) * 100) / 100,
      duration_min: Math.round(route.duration / 60),
      geometry: route.geometry.coordinates.map((c) => ({
        lat: c[1],
        lng: c[0],
      })),
    }));
  }
}
