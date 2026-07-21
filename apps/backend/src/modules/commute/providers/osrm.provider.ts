import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RoutingProvider,
  RouteAlternative,
  RouteResult,
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

  /**
   * Identifier for the cached `route_geom` invalidation contract
   * (#361). Bump this when OSRM's exclusion handling, the driving
   * profile, or the geojson decoding changes shape enough that
   * previously-cached commute polylines should be re-resolved.
   */
  readonly version = 'osrm-v1';

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
    signal?: AbortSignal,
  ): Promise<RouteAlternative[]> {
    const coords = `${originLng},${originLat};${destLng},${destLat}`;
    // `exclude=` support depends on how the OSRM graph was compiled — the
    // public demo server rejects ANY exclude class with 400 InvalidValue
    // ("Exclude flag combination is not supported."), while a self-hosted
    // OSRM built with the classes honours them. We send the avoidances
    // optimistically and fall back to a no-exclude retry on rejection
    // (see fetchOsrm) so the demo fallback still routes.
    //
    // Build the query string manually rather than via URLSearchParams:
    // the WHATWG URL spec percent-encodes commas, producing
    // `exclude=motorway%2Ctoll` — OSRM's custom HTTP handler does not
    // reliably decode `%2C` back to `,`, so the exclude parameter
    // would be silently ignored. The values here are all known-safe
    // (numbers and a fixed enum of OSRM exclusion classes), so direct
    // concatenation is unambiguous.
    // `alternatives=N` tells OSRM to compute *N alternatives in
    // addition to the primary*, so the response contains up to `N + 1`
    // routes. The trip generator's `includePrimary: true` wants
    // `maxAlternatives` candidates including the primary, so we ask
    // for `maxAlternatives - 1` extras. The commute module uses
    // `includePrimary: false` and wants `maxAlternatives` *true*
    // alternatives, so we ask for `maxAlternatives` extras and skip
    // the primary at index 0 below.
    const includePrimary = options?.includePrimary === true;
    const osrmAlternatives = includePrimary
      ? Math.max(0, maxAlternatives - 1)
      : maxAlternatives;
    const exclude = buildExclude(options);
    const data = await this.fetchOsrm(
      (withExclude) =>
        this.buildRouteUrl(
          coords,
          [
            `alternatives=${osrmAlternatives}`,
            `overview=full`,
            `geometries=geojson`,
          ],
          withExclude ? exclude : [],
        ),
      exclude.length > 0,
      'request',
      signal,
    );
    if (!data) return [];
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
    const start = includePrimary ? 0 : 1;
    return data.routes.slice(start, start + maxAlternatives).map((route) => ({
      distance_km: Math.round((route.distance / 1000) * 100) / 100,
      duration_min: Math.round(route.duration / 60),
      geometry: route.geometry.coordinates.map(([lng, lat]) => {
        if (lng === undefined || lat === undefined) {
          throw new Error('OSRM geometry coordinate is missing lng/lat');
        }
        return { lat, lng };
      }),
    }));
  }

  /**
   * Routes via OSRM using the same `/route/v1/driving/{coords}` URL pattern
   * as getAlternatives. OsrmProvider is the last-resort fallback when no
   * GraphHopper/Valhalla env is configured (see routingProviderFactory) —
   * i.e. the default engine on an env-less local checkout.
   */
  async route(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
    signal?: AbortSignal,
  ): Promise<RouteResult | null> {
    if (waypoints.length < 2) return null;
    const coords = waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
    const exclude = buildExclude(options);
    const data = await this.fetchOsrm(
      (withExclude) =>
        this.buildRouteUrl(
          coords,
          ['overview=full', 'geometries=geojson'],
          withExclude ? exclude : [],
        ),
      exclude.length > 0,
      'route',
      signal,
    );
    if (!data) return null;
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const r = data.routes[0];
    if (!r) return null;
    return {
      distance_km: Math.round((r.distance / 1000) * 100) / 100,
      duration_min: Math.round(r.duration / 60),
      geometry: r.geometry.coordinates.map(([lng, lat]) => {
        if (lng === undefined || lat === undefined) {
          throw new Error('OSRM geometry coordinate is missing lng/lat');
        }
        return { lat, lng };
      }),
    };
  }

  private buildRouteUrl(
    coords: string,
    queryParts: string[],
    exclude: string[],
  ): string {
    const parts =
      exclude.length > 0
        ? [...queryParts, `exclude=${exclude.join(',')}`]
        : queryParts;
    return `${this.baseUrl}/route/v1/driving/${coords}?${parts.join('&')}`;
  }

  /**
   * Fetch an OSRM response, retrying once WITHOUT the `exclude=` parameter
   * when the upstream rejects it with 400 (the public demo server's graph
   * has no exclude classes compiled in, so any avoidance fails the whole
   * request). Routing without the rider's avoidances beats not routing at
   * all — but it is logged loudly, because the returned route may use
   * roads the rider asked to avoid.
   */
  private async fetchOsrm(
    buildUrl: (withExclude: boolean) => string,
    hasExclude: boolean,
    context: string,
    signal?: AbortSignal,
  ): Promise<OsrmResponse | null> {
    const requestInit: RequestInit | undefined = signal
      ? { signal }
      : undefined;
    let response = await fetch(buildUrl(true), requestInit);
    if (response.status === 400 && hasExclude) {
      this.logger.warn(
        `OSRM ${context} rejected exclude= (400) — retrying WITHOUT avoidances; this OSRM graph has no exclude classes, so avoid-highways/tolls are ignored`,
      );
      response = await fetch(buildUrl(false), requestInit);
    }
    if (!response.ok) {
      this.logger.error(
        `OSRM ${context} failed: ${response.status} ${response.statusText}`,
      );
      return null;
    }
    return (await response.json()) as OsrmResponse;
  }
}

function buildExclude(options?: RoutingOptions): string[] {
  const exclude: string[] = [];
  if (options?.avoidHighways) exclude.push('motorway');
  if (options?.avoidTolls) exclude.push('toll');
  return exclude;
}
