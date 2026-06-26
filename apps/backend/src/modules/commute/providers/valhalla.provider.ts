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
    if (options?.avoidHighways) costing.use_highways = 0;
    if (options?.avoidTolls) costing.use_tolls = 0;
    return JSON.stringify({
      locations: locations.map((w) => ({ lat: w.lat, lon: w.lng })),
      costing: 'auto',
      directions_options: { units: 'kilometers' },
      ...(Object.keys(costing).length
        ? { costing_options: { auto: costing } }
        : {}),
      ...(alternates && alternates > 0 ? { alternates } : {}),
    });
  }

  private async post(body: string): Promise<ValhallaResponse | null> {
    const res = await fetch(`${this.baseUrl}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      this.logger.error(
        `Valhalla route failed: ${res.status} ${res.statusText}`,
      );
      return null;
    }
    return (await res.json()) as ValhallaResponse;
  }

  private tripToResult(trip: ValhallaTrip): RouteResult {
    const geometry: Array<{ lat: number; lng: number }> = [];
    trip.legs.forEach((leg, idx) => {
      const pts = decodePolyline6(leg.shape);
      // Drop the duplicate join vertex shared with the previous leg.
      geometry.push(...(idx === 0 ? pts : pts.slice(1)));
    });
    return {
      distance_km: Math.round(trip.summary.length * 100) / 100,
      duration_min: Math.round(trip.summary.time / 60),
      geometry,
    };
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
    return trips.slice(0, maxAlternatives).map((t) => this.tripToResult(t));
  }
}
