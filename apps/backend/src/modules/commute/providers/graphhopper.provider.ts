import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RouteAlternative,
  RouteResult,
  RoutingOptions,
  RoutingProvider,
} from '../routing-provider.interface.js';

interface GraphHopperPath {
  distance: number; // metres
  time: number; // milliseconds
  // With `points_encoded: false` GraphHopper returns a GeoJSON LineString
  // here (coordinates are [lng, lat]); we never request the encoded form.
  points: { coordinates: Array<[number, number]> };
}
interface GraphHopperResponse {
  paths?: GraphHopperPath[];
  message?: string;
}

/**
 * GraphHopper implementation of `RoutingProvider`.
 *
 * Why GraphHopper alongside OSRM/Valhalla (ADR-0004): its avoidance +
 * weighting model is an at-request-time JSON `custom_model`, so road
 * filters today — and a future "prefer our own road-quality" weighting —
 * can be tuned without rebuilding the engine. We always run in flexible
 * mode (`ch.disable: true`) because custom models and alternative routes
 * require it.
 *
 * `RoutingOptions` map as:
 *  - `avoidHighways` → `priority` rule zeroing `road_class == MOTORWAY`
 *  - `avoidTolls`    → `priority` rule zeroing `toll != NO`
 *  - `excludePolygons` (#744) → `custom_model.areas` polygons + a
 *    `priority` rule zeroing anything `in_<area>`
 *
 * Self-hosted by default (`TARMOTO_GRAPHHOPPER_BASE_URL`,
 * e.g. `http://localhost:8989`); set `TARMOTO_GRAPHHOPPER_API_KEY` to use
 * the hosted GraphHopper Directions API instead.
 */
@Injectable()
export class GraphHopperProvider implements RoutingProvider {
  private readonly logger = new Logger(GraphHopperProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly profile: string;
  // Bump when the request shape / weighting changes enough that previously
  // cached polylines (#361) should be re-resolved.
  readonly version = 'graphhopper-v1';

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('TARMOTO_GRAPHHOPPER_BASE_URL') ??
      'http://localhost:8989';
    this.apiKey = config.get<string>('TARMOTO_GRAPHHOPPER_API_KEY');
    this.profile = config.get<string>('TARMOTO_GRAPHHOPPER_PROFILE') ?? 'car';
  }

  /** Build the `custom_model` (+ areas) for the avoidance options, or null. */
  private customModel(
    options?: RoutingOptions,
  ): { custom_model: unknown } | null {
    const priority: Array<Record<string, unknown>> = [];
    if (options?.avoidHighways) {
      priority.push({ if: 'road_class == MOTORWAY', multiply_by: 0 });
    }
    if (options?.avoidTolls) {
      priority.push({ if: 'toll != NO', multiply_by: 0 });
    }
    const polygons = options?.excludePolygons ?? [];
    const features = polygons.map((ring, i) => {
      const id = `closure_${i}`;
      priority.push({ if: `in_${id}`, multiply_by: 0 });
      return {
        type: 'Feature',
        id,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {},
      };
    });
    if (priority.length === 0) return null;
    return {
      custom_model: {
        priority,
        ...(features.length
          ? { areas: { type: 'FeatureCollection', features } }
          : {}),
      },
    };
  }

  private body(
    points: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
    maxPaths?: number,
  ): string {
    const model = this.customModel(options);
    const wantsAlternatives = (maxPaths ?? 1) > 1;
    return JSON.stringify({
      points: points.map((p) => [p.lng, p.lat]),
      profile: this.profile,
      points_encoded: false,
      instructions: false,
      // Custom models and alternative routes both require flexible mode.
      ...(model || wantsAlternatives ? { 'ch.disable': true } : {}),
      ...(model ?? {}),
      ...(wantsAlternatives
        ? {
            algorithm: 'alternative_route',
            'alternative_route.max_paths': maxPaths,
          }
        : {}),
    });
  }

  private async post(body: string): Promise<GraphHopperResponse | null> {
    const url = this.apiKey
      ? `${this.baseUrl}/route?key=${encodeURIComponent(this.apiKey)}`
      : `${this.baseUrl}/route`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err: unknown) {
      this.logger.error(
        `GraphHopper unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!res.ok) {
      this.logger.error(
        `GraphHopper route failed: ${res.status} ${res.statusText}`,
      );
      return null;
    }
    try {
      return (await res.json()) as GraphHopperResponse;
    } catch (err: unknown) {
      this.logger.error(
        `GraphHopper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private pathToResult(path: GraphHopperPath): RouteResult | null {
    // Validate before mapping: a malformed HTTP 200 (missing coordinates,
    // non-finite summary) must fall through to the no-route (null) path
    // rather than throwing a 500 or producing bad geometry.
    const coords = path?.points?.coordinates;
    if (
      !Array.isArray(coords) ||
      !Number.isFinite(path.distance) ||
      !Number.isFinite(path.time)
    ) {
      return null;
    }
    const geometry = coords.map((c) => ({ lat: c[1], lng: c[0] }));
    const distance_km = Math.round((path.distance / 1000) * 100) / 100;
    const duration_min = Math.round(path.time / 60000);
    const valid =
      geometry.length >= 2 &&
      geometry.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) &&
      Number.isFinite(distance_km) &&
      Number.isFinite(duration_min);
    if (!valid) return null;
    return { distance_km, duration_min, geometry };
  }

  async route(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
  ): Promise<RouteResult | null> {
    if (waypoints.length < 2) return null;
    const data = await this.post(this.body(waypoints, options));
    const path = data?.paths?.[0];
    if (!path) return null;
    return this.pathToResult(path);
  }

  async getAlternatives(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    maxAlternatives: number,
    options?: RoutingOptions,
  ): Promise<RouteAlternative[]> {
    const includePrimary = options?.includePrimary === true;
    // GraphHopper returns the primary as paths[0]; ask for one extra when
    // the caller only wants *other* routes so we can drop it.
    const requestPaths = includePrimary ? maxAlternatives : maxAlternatives + 1;
    const data = await this.post(
      this.body(
        [
          { lat: originLat, lng: originLng },
          { lat: destLat, lng: destLng },
        ],
        options,
        requestPaths,
      ),
    );
    const paths = data?.paths ?? [];
    const chosen = includePrimary
      ? paths.slice(0, maxAlternatives)
      : paths.slice(1, maxAlternatives + 1);
    return chosen
      .map((p) => this.pathToResult(p))
      .filter((r): r is RouteAlternative => r !== null);
  }
}
