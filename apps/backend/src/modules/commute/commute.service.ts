import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { pointToLatLng, latLngToPoint } from '@tarmoto/shared';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
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
  constructor(
    @InjectRepository(CommuteRoute)
    private readonly routeRepo: Repository<CommuteRoute>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    private readonly dataSource: DataSource,
    @Inject(ROUTING_PROVIDER)
    private readonly routingProvider: RoutingProvider,
  ) {}

  async listRoutes(userId: string): Promise<CommuteRouteResponseDto[]> {
    const routes = await this.routeRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
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

    const hazardCount = await this.countHazardsNearLine(route);

    let status: string = 'clear';
    if (hazardCount > 0) status = 'hazards';

    const response = this.toRouteResponse(route);

    return {
      route: response,
      hazard_count: hazardCount,
      route_quality: route.avg_quality,
      status,
    };
  }

  async getStats(
    userId: string,
    period: 'week' | 'month' = 'week',
  ): Promise<CommuteStatsResponseDto> {
    const intervalDays = period === 'month' ? 30 : 7;
    const intervalLiteral = `${intervalDays} days`;

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
           AND started_at > NOW() - INTERVAL '${intervalLiteral}'
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
           AND started_at > NOW() - INTERVAL '${intervalLiteral} 2'
           AND started_at <= NOW() - INTERVAL '${intervalLiteral}'`,
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

    const [originLng, originLat] = this.getCoords(route.origin);
    const [destLng, destLat] = this.getCoords(route.destination);

    // Get hazard count on primary route and fetch alternatives in parallel
    const [primaryHazardCount, rawAlternatives] = await Promise.all([
      this.countHazardsNearLine(route),
      this.routingProvider.getAlternatives(
        originLat,
        originLng,
        destLat,
        destLng,
        3,
      ),
    ]);

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

  private async countHazardsNearLine(route: CommuteRoute): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT COUNT(*)::int AS count
       FROM hazard_reports hr
       WHERE hr.is_active = true AND hr.expires_at > NOW()
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
      avg_quality: route.avg_quality,
      is_primary: route.is_primary,
      created_at: route.created_at.toISOString(),
    };
  }

  private getCoords(point: unknown): [number, number] {
    const geo = point as { coordinates: [number, number] };
    return geo.coordinates;
  }
}
