import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RouteAlternative,
  RouteResult,
  RoutingOptions,
  RoutingProvider,
} from '../routing-provider.interface.js';

interface ValhallaLeg {
  shape: string;
  summary: { length: number; time: number };
}
interface ValhallaTrip {
  legs: ValhallaLeg[];
  summary: { length: number; time: number };
}
interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
}

/** Decode a Google-encoded polyline at precision 1e6 (Valhalla default). */
function decodePolyline6(encoded: string): Array<{ lat: number; lng: number }> {
  const out: Array<{ lat: number; lng: number }> = [];
  let i = 0,
    lat = 0,
    lng = 0;
  const next = () => {
    let shift = 0,
      result = 0,
      b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}

@Injectable()
export class ValhallaProvider implements RoutingProvider {
  private readonly logger = new Logger(ValhallaProvider.name);
  private readonly baseUrl: string;
  readonly version = 'valhalla-v1';

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('TARMOTO_VALHALLA_BASE_URL') ??
      'http://localhost:8002';
  }

  private body(
    locations: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
    alternates?: number,
  ): string {
    const costing: Record<string, number> = {};
    // Road character (revision 3): weight highway usage down as the rider
    // asks for more fun. Applied BEFORE the avoid flags so a hard avoid
    // always wins over a soft preference.
    switch (options?.preference) {
      case 'maximum_twisty':
        costing.use_highways = 0.05;
        break;
      case 'scenic_balance':
        costing.use_highways = 0.2;
        break;
      case 'balanced':
        costing.use_highways = 0.5;
        break;
      // 'direct' / 'efficient_loop' / unset: engine default (fastest).
      default:
        break;
    }
    if (options?.avoidHighways) costing.use_highways = 0;
    if (options?.avoidTolls) costing.use_tolls = 0;
    // Closure avoidance (#744): Valhalla's `exclude_polygons` is an array
    // of polygons, each an array of `[lon, lat]` pairs. Our rings are
    // already `[lng, lat]` (== `[lon, lat]`), so pass them through.
    const excludePolygons = options?.excludePolygons;
    return JSON.stringify({
      locations: locations.map((w) => ({ lat: w.lat, lon: w.lng })),
      costing: 'auto',
      directions_options: { units: 'kilometers' },
      ...(Object.keys(costing).length
        ? { costing_options: { auto: costing } }
        : {}),
      ...(excludePolygons && excludePolygons.length
        ? { exclude_polygons: excludePolygons }
        : {}),
      ...(alternates && alternates > 0 ? { alternates } : {}),
    });
  }

  private async post(body: string): Promise<ValhallaResponse | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err: unknown) {
      this.logger.error(
        `Valhalla unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!res.ok) {
      this.logger.error(
        `Valhalla route failed: ${res.status} ${res.statusText}`,
      );
      return null;
    }
    try {
      return (await res.json()) as ValhallaResponse;
    } catch (err: unknown) {
      this.logger.error(
        `Valhalla returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private tripToResult(trip: ValhallaTrip): RouteResult | null {
    // Validate the raw trip BEFORE decoding: a malformed HTTP 200 (e.g. a leg
    // missing a string `shape`, or a non-finite summary) would otherwise make
    // decodePolyline6 read `undefined.length` and throw a 500 instead of
    // following the intended no-route (null) path.
    if (
      !Array.isArray(trip.legs) ||
      trip.legs.length === 0 ||
      !trip.legs.every((leg) => typeof leg?.shape === 'string') ||
      !trip.summary ||
      !Number.isFinite(trip.summary.length) ||
      !Number.isFinite(trip.summary.time)
    ) {
      return null;
    }
    const geometry: Array<{ lat: number; lng: number }> = [];
    trip.legs.forEach((leg, idx) => {
      const pts = decodePolyline6(leg.shape);
      // Drop the duplicate join vertex shared with the previous leg.
      geometry.push(...(idx === 0 ? pts : pts.slice(1)));
    });
    // Reject degenerate shapes (Valhalla can 200 with an empty/one-point or
    // non-finite shape): a valid LineString needs >=2 finite points, and the
    // summary must be finite. Otherwise /routing/route would hand back invalid
    // geometry and a later save would build bad route_geom (PostGIS 500). Return
    // null so callers fall through to the no-route (502) path.
    const distance_km = Math.round(trip.summary.length * 100) / 100;
    const duration_min = Math.round(trip.summary.time / 60);
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
    if (!data?.trip?.legs?.length) return null;
    return this.tripToResult(data.trip);
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
    const extras = includePrimary
      ? Math.max(0, maxAlternatives - 1)
      : maxAlternatives;
    const data = await this.post(
      this.body(
        [
          { lat: originLat, lng: originLng },
          { lat: destLat, lng: destLng },
        ],
        options,
        extras,
      ),
    );
    if (!data?.trip) return [];
    const trips: ValhallaTrip[] = [
      ...(includePrimary ? [data.trip] : []),
      ...(data.alternates ?? []).map((a) => a.trip),
    ];
    return trips
      .slice(0, maxAlternatives)
      .map((t) => this.tripToResult(t))
      .filter((r): r is RouteAlternative => r !== null);
  }
}
