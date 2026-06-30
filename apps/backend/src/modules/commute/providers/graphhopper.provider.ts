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
 * can be tuned without rebuilding the engine. Flexible mode
 * (`ch.disable: true`) is used only for custom models (which require it);
 * `alternative_route` runs under Contraction Hierarchies.
 *
 * `RoutingOptions` map as:
 *  - `avoidHighways` → `priority` rule zeroing `road_class == MOTORWAY`
 *  - `avoidTolls`    → `priority` rule zeroing `toll == ALL || toll == HGV`
 *    (GraphHopper's actual toll values — `MISSING`/`NO` are untolled).
 *    Requires the `toll` encoded value, which the hosted API has but a
 *    self-hosted `config-example.yml` graph does not; gated by
 *    `TARMOTO_GRAPHHOPPER_TOLL_ENABLED` (default: on for hosted, off for
 *    self-hosted). When unavailable, avoidTolls is a silent no-op.
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
  // Whether the configured graph exposes the `toll` encoded value. The
  // hosted Directions API does; a self-hosted graph from the upstream
  // `config-example.yml` does NOT, and referencing an unknown encoded value
  // makes GraphHopper reject the whole request. Gate the avoidTolls rule on
  // this: when off, avoidTolls is a silent no-op (the `RoutingProvider`
  // contract for an avoidance the engine can't honour) instead of a
  // no-route failure.
  private readonly tollSupported: boolean;

  // Bump when the request shape / weighting changes enough that previously
  // cached polylines (#361) should be re-resolved.
  readonly version = 'graphhopper-v1';

  constructor(config: ConfigService) {
    // Normalize blank/whitespace env values to unset (templated env files
    // often emit `TARMOTO_GRAPHHOPPER_BASE_URL=`), matching how the factory
    // already treats them — otherwise a blank base URL would survive `??`
    // and the provider would fetch a relative `/route?key=...`.
    this.apiKey =
      config.get<string>('TARMOTO_GRAPHHOPPER_API_KEY')?.trim() || undefined;
    const explicitBase = config
      .get<string>('TARMOTO_GRAPHHOPPER_BASE_URL')
      ?.trim();
    // We're on the hosted Directions API only when no explicit base URL is
    // set AND an API key is — an explicit base wins (the request goes there
    // even if a leftover/proxy key is also present).
    const usingHostedApi = !explicitBase && this.apiKey !== undefined;
    this.baseUrl =
      explicitBase ||
      (usingHostedApi
        ? 'https://graphhopper.com/api/1'
        : 'http://localhost:8989');
    this.profile =
      config.get<string>('TARMOTO_GRAPHHOPPER_PROFILE')?.trim() || 'car';
    // Explicit flag wins; otherwise default to true only when we actually
    // hit the hosted API (which ships the `toll` encoded value) — NOT merely
    // when a key exists, since an explicit self-hosted base routes to a graph
    // that likely lacks `toll`. Self-hosted operators add `toll` to
    // `graph.encoded_values` and set the flag.
    const tollFlag = config
      .get<string>('TARMOTO_GRAPHHOPPER_TOLL_ENABLED')
      ?.trim()
      .toLowerCase();
    this.tollSupported =
      tollFlag === 'true'
        ? true
        : tollFlag === 'false'
          ? false
          : usingHostedApi;
  }

  /** Build the `custom_model` (+ areas) for the avoidance options, or null. */
  private customModel(
    options?: RoutingOptions,
  ): { custom_model: unknown } | null {
    const priority: Array<Record<string, unknown>> = [];
    if (options?.avoidHighways) {
      priority.push({ if: 'road_class == MOTORWAY', multiply_by: 0 });
    }
    if (options?.avoidTolls && this.tollSupported) {
      // Match GraphHopper's actual toll values, NOT `toll != NO`: most
      // untolled OSM roads have no toll tag (`toll == MISSING`), so
      // `!= NO` would exclude nearly the whole graph and return no route.
      priority.push({ if: 'toll == ALL || toll == HGV', multiply_by: 0 });
    } else if (options?.avoidTolls) {
      // No-op per the RoutingProvider contract: the graph has no `toll`
      // encoded value, so referencing it would make GraphHopper reject the
      // request. Better to route without honouring the flag than no route.
      this.logger.debug(
        'avoidTolls ignored: GraphHopper graph has no `toll` encoded value ' +
          '(set TARMOTO_GRAPHHOPPER_TOLL_ENABLED=true once provisioned)',
      );
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
      // `ch.disable` ONLY for custom models — they require flexible mode.
      // `algorithm=alternative_route` works under Contraction Hierarchies,
      // and forcing `ch.disable` on a CH-only server profile gets the
      // request rejected, so plain (filter-less) alternatives keep CH.
      ...(model ? { 'ch.disable': true } : {}),
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
