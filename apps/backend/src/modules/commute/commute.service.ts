import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { pointToLatLng, latLngToPoint } from '@tarmoto/shared';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { HazardsService } from '../hazards/hazards.service.js';
import { WeatherService } from '../weather/weather.service.js';
import { ClosuresService } from '../closures/closures.service.js';
import type { HazardResponseDto } from '../hazards/dto/hazard-response.dto.js';
import type { WeatherResponseDto } from '../weather/dto/weather.dto.js';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from './routing-provider.interface.js';
import {
  CreateCommuteRouteDto,
  CommuteRouteResponseDto,
  CommuteStatusResponseDto,
  CommuteStatsResponseDto,
  CommuteStatsPeriodDto,
  AlternativeRouteDto,
  CommuteAlternativesResponseDto,
} from './dto/commute.dto.js';

const FUEL_L_PER_KM = 0.05; // ~5L/100km average motorcycle

@Injectable()
export class CommuteService {
  private readonly logger = new Logger(CommuteService.name);

  constructor(
    @InjectRepository(CommuteRoute)
    private readonly routeRepo: Repository<CommuteRoute>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    private readonly dataSource: DataSource,
    @Inject(ROUTING_PROVIDER)
    private readonly routingProvider: RoutingProvider,
    private readonly hazardsService: HazardsService,
    private readonly weatherService: WeatherService,
    private readonly closuresService: ClosuresService,
  ) {}

  /**
   * Bounding box around two endpoints, padded so closures just off the
   * straight-line corridor (which a detour might still touch) are caught
   * (#744). Keeps the closure query bounded — never the whole country.
   */
  private endpointBbox(
    aLng: number,
    aLat: number,
    bLng: number,
    bLat: number,
  ): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
    const pad = 0.05; // ~5 km
    return {
      minLng: Math.min(aLng, bLng) - pad,
      minLat: Math.min(aLat, bLat) - pad,
      maxLng: Math.max(aLng, bLng) + pad,
      maxLat: Math.max(aLat, bLat) + pad,
    };
  }

  async listRoutes(userId: string): Promise<CommuteRouteResponseDto[]> {
    const routes = await this.routeRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    // Lazily backfill the primary route's cache so legacy rows (saved
    // before route_geom/distance_km/avg_duration were populated) gain a
    // polyline + duration without a separate migration. Only the primary
    // is filled here — backfilling every saved row would amplify a list
    // call into N×OSRM hits, which is wasteful for routes the rider may
    // not be looking at right now.
    const primary = routes.find((r) => r.is_primary);
    if (primary && this.needsCacheFill(primary)) {
      await this.fillRouteCache(primary);
    }
    return routes.map((r) => this.toRouteResponse(r));
  }

  async createRoute(
    userId: string,
    dto: CreateCommuteRouteDto,
  ): Promise<CommuteRouteResponseDto> {
    // Transaction ensures atomic primary flag swap + insert
    const saved = await this.dataSource.transaction(async (manager) => {
      // Unset primary on all existing routes
      await manager.update(
        CommuteRoute,
        { user_id: userId, is_primary: true },
        { is_primary: false },
      );

      const route = manager.create(CommuteRoute, {
        user_id: userId,
        name: dto.name ?? 'Default',
        is_primary: true,
        origin: latLngToPoint(dto.origin),
        destination: latLngToPoint(dto.destination),
      });

      return manager.save(route);
    });

    // Resolve the route via the routing provider after the row has been
    // committed: a network failure shouldn't reject the whole creation,
    // and lazy backfill on subsequent reads will retry. Best-effort.
    await this.fillRouteCache(saved);

    return this.toRouteResponse(saved);
  }

  async setPrimaryRoute(
    userId: string,
    routeId: string,
  ): Promise<CommuteRouteResponseDto> {
    // Atomic swap: a single transaction unsets `is_primary` on every other
    // saved route for this user and flips it on for the target. Without
    // the transaction a transient failure between the two writes could
    // leave the user with zero primary routes (which makes
    // /commute/status and /commute/alternatives 404 even though the
    // rider has saved routes).
    const updated = await this.dataSource.transaction(async (manager) => {
      const target = await manager.findOne(CommuteRoute, {
        where: { id: routeId, user_id: userId },
      });
      if (!target) {
        throw new NotFoundException('Commute route not found');
      }

      // Skip the writes if the target is already primary so a no-op tap
      // doesn't churn the row's updated_at and doesn't burn an UPDATE.
      if (!target.is_primary) {
        await manager.update(
          CommuteRoute,
          { user_id: userId, is_primary: true },
          { is_primary: false },
        );
        target.is_primary = true;
        await manager.save(target);
      }

      return target;
    });

    return this.toRouteResponse(updated);
  }

  async deleteRoute(userId: string, routeId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const route = await manager.findOne(CommuteRoute, {
        where: { id: routeId, user_id: userId },
      });
      if (!route) {
        throw new NotFoundException('Commute route not found');
      }

      const wasPrimary = route.is_primary;
      await manager.remove(route);

      // If deleted route was primary, promote the most recent remaining route
      if (wasPrimary) {
        const next = await manager.findOne(CommuteRoute, {
          where: { user_id: userId },
          order: { created_at: 'DESC' },
        });
        if (next) {
          next.is_primary = true;
          await manager.save(next);
        }
      }
    });
  }

  async getStatus(userId: string): Promise<CommuteStatusResponseDto> {
    const route = await this.routeRepo.findOne({
      where: { user_id: userId, is_primary: true },
    });
    if (!route) {
      throw new NotFoundException('No primary commute route configured');
    }

    if (this.needsCacheFill(route)) {
      await this.fillRouteCache(route);
    }

    // Fan-out: pre-#353 the mobile client fired three requests
    // (status, hazards, weather) and stitched them together. We do the
    // composition server-side now so the rider gets one round-trip and
    // a consistent response shape. Weather is best-effort — a provider
    // outage shouldn't blank the whole commute card, so we surface
    // `null` and let the client decide whether to show a placeholder.
    const [hazards, weather] = await Promise.all([
      this.findHazardsAlongRoute(route),
      this.fetchOriginWeather(route),
    ]);

    const hazardCount = hazards.length;
    const status: string = hazardCount > 0 ? 'hazards' : 'clear';
    const estimatedTimeMin = this.parseIntervalMinutes(route.avg_duration);

    const response = this.toRouteResponse(route);

    return {
      route: response,
      hazards,
      hazard_count: hazardCount,
      weather,
      estimated_time_min: estimatedTimeMin,
      route_quality: route.avg_quality,
      status,
    };
  }

  async getStats(
    userId: string,
    period: 'week' | 'month' = 'week',
  ): Promise<CommuteStatsResponseDto> {
    const intervalDays = period === 'month' ? 30 : 7;
    // Build the SQL interval literals from the day count rather than
    // string-concatenating " 2" onto a "7 days" string. Postgres parses
    // each unit-less token in an INTERVAL literal as seconds, so a naive
    // `'${intervalLiteral} 2'` expanded to `'7 days 2'` and resolved to
    // `7 days + 2 seconds` — which collapsed the prior window to a
    // 2-second slice and made every "vs last week" trend zero.
    const currentIntervalLiteral = `${intervalDays} days`;
    const priorBoundaryLiteral = `${intervalDays * 2} days`;

    // Pull the current period (with daily breakdown) and the immediately
    // prior period (totals only) in parallel — the trend section in
    // CommuteScreen needs both. We deliberately don't lump them into one
    // query: the daily breakdown is only meaningful for the current
    // window and the prior totals are the simpler aggregate that the
    // mobile UI surfaces as "vs last week".
    type CurrentRow = {
      date: string;
      rides: number;
      km: number;
      duration_min: number;
    };
    type PriorRow = {
      rides: number;
      km: number | null;
      duration_min: number;
    };
    const [currentRows, priorRows] = (await Promise.all([
      this.rideRepo.query(
        `SELECT
           DATE(started_at) AS date,
           COUNT(*)::int AS rides,
           COALESCE(SUM(distance_km), 0)::float AS km,
           COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS duration_min
         FROM rides
         WHERE user_id = $1
           AND ride_type = 'commute'
           AND status = 'completed'
           AND started_at > NOW() - INTERVAL '${currentIntervalLiteral}'
         GROUP BY DATE(started_at)
         ORDER BY date DESC`,
        [userId],
      ),
      this.rideRepo.query(
        `SELECT
           COUNT(*)::int AS rides,
           COALESCE(SUM(distance_km), 0)::float AS km,
           COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS duration_min
         FROM rides
         WHERE user_id = $1
           AND ride_type = 'commute'
           AND status = 'completed'
           AND started_at > NOW() - INTERVAL '${priorBoundaryLiteral}'
           AND started_at <= NOW() - INTERVAL '${currentIntervalLiteral}'`,
        [userId],
      ),
    ])) as [CurrentRow[], PriorRow[]];

    const dailyBreakdown = currentRows.map((r) => ({
      date: r.date,
      rides: r.rides,
      km: Math.round(r.km * 100) / 100,
      duration_min: r.duration_min,
    }));

    const current = this.toStatsPeriod(
      dailyBreakdown.reduce((sum, d) => sum + d.rides, 0),
      dailyBreakdown.reduce((sum, d) => sum + d.km, 0),
      dailyBreakdown.reduce((sum, d) => sum + d.duration_min, 0),
    );

    const priorRaw = priorRows[0];
    const previous = this.toStatsPeriod(
      priorRaw?.rides ?? 0,
      priorRaw?.km ?? 0,
      priorRaw?.duration_min ?? 0,
    );

    return {
      period,
      total_rides: current.total_rides,
      total_km: current.total_km,
      total_time_min: current.total_time_min,
      avg_duration_min: current.avg_duration_min,
      fuel_estimate_l: current.fuel_estimate_l,
      daily_breakdown: dailyBreakdown,
      previous_period: previous,
    };
  }

  private toStatsPeriod(
    totalRides: number,
    totalKmRaw: number,
    totalTimeMin: number,
  ): CommuteStatsPeriodDto {
    const totalKm = Math.round(totalKmRaw * 100) / 100;
    return {
      total_rides: totalRides,
      total_km: totalKm,
      total_time_min: totalTimeMin,
      avg_duration_min:
        totalRides > 0 ? Math.round(totalTimeMin / totalRides) : 0,
      fuel_estimate_l: Math.round(totalKmRaw * FUEL_L_PER_KM * 100) / 100,
    };
  }

  async getAlternatives(
    userId: string,
  ): Promise<CommuteAlternativesResponseDto> {
    const route = await this.routeRepo.findOne({
      where: { user_id: userId, is_primary: true },
    });
    if (!route) {
      throw new NotFoundException('No primary commute route configured');
    }

    if (this.needsCacheFill(route)) {
      await this.fillRouteCache(route);
    }

    const [originLng, originLat] = this.getCoords(route.origin);
    const [destLng, destLat] = this.getCoords(route.destination);

    // Fetch hazard count + closure-exclusion polygons in parallel, then
    // route around the closures (#744).
    const bbox = this.endpointBbox(originLng, originLat, destLng, destLat);
    const [primaryHazardCount, excludePolygons] = await Promise.all([
      this.countHazardsNearLine(route),
      this.closuresService.exclusionPolygons(bbox),
    ]);
    const rawAlternatives = await this.routingProvider.getAlternatives(
      originLat,
      originLng,
      destLat,
      destLng,
      3,
      { excludePolygons },
    );

    // Enrich each alternative with hazard count and avg road quality
    const alternatives: AlternativeRouteDto[] = await Promise.all(
      rawAlternatives.map(async (alt) => {
        const [hazardCount, avgQuality] = await Promise.all([
          this.countHazardsAlongGeometry(alt.geometry),
          this.avgQualityAlongGeometry(alt.geometry),
        ]);
        return {
          distance_km: alt.distance_km,
          duration_min: alt.duration_min,
          avg_quality: avgQuality,
          hazard_count: hazardCount,
          geometry: alt.geometry,
        };
      }),
    );

    return {
      primary_route: this.toRouteResponse(route),
      primary_hazard_count: primaryHazardCount,
      alternatives,
    };
  }

  /**
   * Build the polyline used to look up hazards on the rider's commute.
   * Prefers the cached `route_geom` so we follow the actual road shape;
   * falls back to a straight origin → destination line when the cache
   * hasn't been populated yet. The 500 m buffer matches the legacy
   * `countHazardsNearLine` semantics so `hazard_count` doesn't change
   * meaning when we ship #353.
   */
  private routeLineForHazards(
    route: CommuteRoute,
  ): Array<{ lat: number; lng: number }> {
    const cached = this.lineStringToLatLngs(route.route_geom);
    if (cached && cached.length >= 2) return cached;
    const [originLng, originLat] = this.getCoords(route.origin);
    const [destLng, destLat] = this.getCoords(route.destination);
    return [
      { lat: originLat, lng: originLng },
      { lat: destLat, lng: destLng },
    ];
  }

  /**
   * Active hazards within 500 m of the commute route. Delegates to
   * `HazardsService.findAlongRoute` so the wire shape, ordering, and
   * filtering rules stay single-sourced — fixing a hazard query bug
   * doesn't need a parallel patch here.
   */
  private async findHazardsAlongRoute(
    route: CommuteRoute,
  ): Promise<HazardResponseDto[]> {
    const line = this.routeLineForHazards(route);
    return this.hazardsService.findAlongRoute({ route: line, buffer_m: 500 });
  }

  /**
   * Sample current conditions at the route origin — that's where the
   * rider is when they open the commute card. Best-effort: a provider
   * outage logs a warning and returns `null` so the rest of the
   * status response (route, hazards, quality) still reaches the
   * client. The `WeatherService` itself doesn't surface a partial
   * shape, so we wrap the call instead of pushing the try/catch
   * downstream.
   */
  private async fetchOriginWeather(
    route: CommuteRoute,
  ): Promise<WeatherResponseDto | null> {
    const [lng, lat] = this.getCoords(route.origin);
    try {
      return await this.weatherService.getCurrentWeather(lat, lng);
    } catch (err) {
      this.logger.warn(
        `Weather lookup failed for commute route ${route.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async countHazardsNearLine(route: CommuteRoute): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT COUNT(*)::int AS count
       FROM hazard_reports hr
       WHERE hr.is_active = true AND hr.expires_at > NOW()
         AND hr.moderation_status = 'visible'
         AND ST_DWithin(
           hr.location::geography,
           ST_MakeLine(
             ST_SetSRID(ST_MakePoint($1, $2), 4326),
             ST_SetSRID(ST_MakePoint($3, $4), 4326)
           )::geography,
           500
         )`,
      [...this.getCoords(route.origin), ...this.getCoords(route.destination)],
    );
    return (rows as Array<{ count: number }>)[0]?.count ?? 0;
  }

  private geometryToWkt(geometry: Array<{ lat: number; lng: number }>): string {
    const coords = geometry.map((p) => {
      const lng = Number(p.lng);
      const lat = Number(p.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new Error('Invalid coordinate in route geometry');
      }
      return `${lng} ${lat}`;
    });
    return `LINESTRING(${coords.join(',')})`;
  }

  private async countHazardsAlongGeometry(
    geometry: Array<{ lat: number; lng: number }>,
  ): Promise<number> {
    if (geometry.length < 2) return 0;

    const wkt = this.geometryToWkt(geometry);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT COUNT(*)::int AS count
       FROM hazard_reports hr
       WHERE hr.is_active = true AND hr.expires_at > NOW()
         AND hr.moderation_status = 'visible'
         AND ST_DWithin(
           hr.location::geography,
           ST_GeomFromText($1, 4326)::geography,
           500
         )`,
      [wkt],
    );
    return (rows as Array<{ count: number }>)[0]?.count ?? 0;
  }

  private async avgQualityAlongGeometry(
    geometry: Array<{ lat: number; lng: number }>,
  ): Promise<number | null> {
    if (geometry.length < 2) return null;

    const wkt = this.geometryToWkt(geometry);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT AVG(rs.quality_score)::float AS avg_quality
       FROM road_segments rs
       WHERE rs.quality_score IS NOT NULL
         AND ST_DWithin(
           rs.geom::geography,
           ST_GeomFromText($1, 4326)::geography,
           100
         )`,
      [wkt],
    );
    const avg = (rows as Array<{ avg_quality: number | null }>)[0]?.avg_quality;
    return avg != null ? Math.round(avg * 10) / 10 : null;
  }

  private toRouteResponse(route: CommuteRoute): CommuteRouteResponseDto {
    return {
      id: route.id,
      name: route.name,
      origin: pointToLatLng(route.origin)!,
      destination: pointToLatLng(route.destination)!,
      distance_km: route.distance_km,
      avg_duration_min: this.parseIntervalMinutes(route.avg_duration),
      route_geometry: this.lineStringToLatLngs(route.route_geom),
      avg_quality: route.avg_quality,
      is_primary: route.is_primary,
      created_at: route.created_at.toISOString(),
    };
  }

  private getCoords(point: unknown): [number, number] {
    const geo = point as { coordinates: [number, number] };
    return geo.coordinates;
  }

  /**
   * True when the cached routing-engine fields haven't been populated
   * yet — either because the route was created before this cache existed
   * or because a previous fillRouteCache call failed (OSRM unreachable
   * etc.) — OR because the cached geometry was produced by a routing
   * engine version that no longer matches the active provider (#361
   * — engine swap or material algorithm bump should invalidate the
   * cache lazily on next read). The geometry is the canonical signal
   * for the null case: distance/duration without geometry would mean
   * a partial fill, which we never write.
   *
   * `routing_engine_version` is nullable on legacy rows that were
   * resolved before the column existed; treat null-but-geometry-set
   * as a stale fill so the next read upgrades them to the current
   * version. Origin/destination changes are out-of-band today (no
   * UPDATE endpoint exists; mutating either requires a re-create
   * which yields a fresh row with route_geom = null), so this method
   * doesn't compare against the cached endpoints — but it would be
   * the natural place to add that check if a future PR introduces an
   * UPDATE path.
   */
  private needsCacheFill(route: CommuteRoute): boolean {
    if (route.route_geom == null) return true;
    return route.routing_engine_version !== this.routingProvider.version;
  }

  /**
   * Resolve route_geom, distance_km, and avg_duration by hitting the
   * routing provider and persisting the result on the entity.
   * Best-effort: any failure is logged and swallowed so callers can
   * continue serving the row with the cache fields still null. The
   * route argument is mutated in place so the caller doesn't need to
   * re-fetch after the write.
   */
  private async fillRouteCache(route: CommuteRoute): Promise<void> {
    const [originLng, originLat] = this.getCoords(route.origin);
    const [destLng, destLat] = this.getCoords(route.destination);

    let resolved;
    try {
      // includePrimary: true so we get the engine's main route (lowest
      // duration), not just alternatives. Asking for one route keeps
      // the upstream payload small. Route around active full closures (#744).
      const bbox = this.endpointBbox(originLng, originLat, destLng, destLat);
      const excludePolygons =
        await this.closuresService.exclusionPolygons(bbox);
      const candidates = await this.routingProvider.getAlternatives(
        originLat,
        originLng,
        destLat,
        destLng,
        1,
        { includePrimary: true, excludePolygons },
      );
      resolved = candidates[0];
    } catch (err) {
      this.logger.warn(
        `Failed to resolve commute route ${route.id} via routing provider: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (!resolved || resolved.geometry.length < 2) {
      this.logger.debug(
        `Routing provider returned no geometry for commute route ${route.id}; leaving cache fields null.`,
      );
      return;
    }

    // Round duration here rather than at the SQL boundary: postgres'
    // `make_interval(mins => …)` takes an `int`, and a fractional
    // value sent through the pg driver would parse-fail every retry,
    // pinning the cache permanently null for that route. The
    // RoutingProvider interface allows non-integer minutes (OSRM
    // happens to round, but a future provider doesn't have to).
    const durationMin = Math.round(resolved.duration_min);

    const engineVersion = this.routingProvider.version;

    try {
      // `geometryToWkt` validates each coordinate with `Number.isFinite`
      // and throws on a bad point — wrapping it in this try makes that
      // a logged warning, consistent with the rest of fillRouteCache.
      const wkt = this.geometryToWkt(resolved.geometry);
      // `routing_engine_version` is written atomically with the cache
      // payload so a reader can never observe geometry from one engine
      // tagged with a different engine's version (#361 — keeps the
      // invalidation check honest under retry).
      await this.routeRepo.query(
        `UPDATE commute_routes
         SET route_geom = ST_GeomFromText($1, 4326),
             distance_km = $2,
             avg_duration = make_interval(mins => $3),
             routing_engine_version = $4
         WHERE id = $5`,
        [wkt, resolved.distance_km, durationMin, engineVersion, route.id],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist commute route ${route.id} cache: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Mirror the persisted values onto the in-memory entity so the
    // current request returns a populated DTO without a re-fetch.
    route.route_geom = {
      type: 'LineString',
      coordinates: resolved.geometry.map((p) => [p.lng, p.lat]),
    };
    route.distance_km = resolved.distance_km;
    route.routing_engine_version = engineVersion;
    // Canonical HH:MM:SS form so the parser produces the same number
    // we just persisted when this entity is reloaded later.
    const hh = Math.floor(durationMin / 60);
    const mm = durationMin % 60;
    route.avg_duration = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  }

  private lineStringToLatLngs(
    geom: unknown,
  ): Array<{ lat: number; lng: number }> | null {
    if (geom == null) return null;
    const line = geom as { coordinates?: number[][] };
    if (!Array.isArray(line.coordinates) || line.coordinates.length === 0) {
      return null;
    }
    return line.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
  }

  /**
   * Parse a Postgres interval into whole minutes. TypeORM types the
   * column as `string` but the pg driver's default parser returns an
   * object (`{ days, hours, minutes, seconds, milliseconds }`); both
   * shapes show up at runtime depending on driver configuration, so
   * accept either. Anything we can't parse is reported as null so the
   * wire shape stays predictable rather than emitting NaN.
   */
  private parseIntervalMinutes(interval: unknown): number | null {
    if (interval == null) return null;

    if (typeof interval === 'object') {
      const v = interval as {
        days?: number;
        hours?: number;
        minutes?: number;
        seconds?: number;
      };
      const total =
        (v.days ?? 0) * 1440 +
        (v.hours ?? 0) * 60 +
        (v.minutes ?? 0) +
        (v.seconds ?? 0) / 60;
      return Number.isFinite(total) ? Math.round(total) : null;
    }

    if (typeof interval !== 'string') return null;

    const match = /(?:(\d+) days? )?(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(interval);
    if (!match) return null;
    const days = match[1] ? Number(match[1]) : 0;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    if (
      !Number.isFinite(days) ||
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      return null;
    }
    return Math.round(days * 1440 + hours * 60 + minutes + seconds / 60);
  }
}
