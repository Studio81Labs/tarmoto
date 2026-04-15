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

    // Count active hazards near the route
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const hazardRows = await this.routeRepo.query(
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
    const hazardCount = (hazardRows as Array<{ count: number }>)[0]?.count ?? 0;

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
    const interval = period === 'month' ? '30 days' : '7 days';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.rideRepo.query(
      `SELECT
         DATE(started_at) AS date,
         COUNT(*)::int AS rides,
         COALESCE(SUM(distance_km), 0)::float AS km,
         COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS duration_min
       FROM rides
       WHERE user_id = $1
         AND ride_type = 'commute'
         AND status = 'completed'
         AND started_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE(started_at)
       ORDER BY date DESC`,
      [userId],
    );

    const dailyBreakdown = (
      rows as Array<{
        date: string;
        rides: number;
        km: number;
        duration_min: number;
      }>
    ).map((r) => ({
      date: r.date,
      rides: r.rides,
      km: Math.round(r.km * 100) / 100,
      duration_min: r.duration_min,
    }));

    const totalRides = dailyBreakdown.reduce((sum, d) => sum + d.rides, 0);
    const totalKm = dailyBreakdown.reduce((sum, d) => sum + d.km, 0);
    const totalTimeMin = dailyBreakdown.reduce(
      (sum, d) => sum + d.duration_min,
      0,
    );

    return {
      period,
      total_rides: totalRides,
      total_km: Math.round(totalKm * 100) / 100,
      total_time_min: totalTimeMin,
      avg_duration_min:
        totalRides > 0 ? Math.round(totalTimeMin / totalRides) : 0,
      fuel_estimate_l: Math.round(totalKm * FUEL_L_PER_KM * 100) / 100,
      daily_breakdown: dailyBreakdown,
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

  private async countHazardsAlongGeometry(
    geometry: Array<{ lat: number; lng: number }>,
  ): Promise<number> {
    if (geometry.length < 2) return 0;

    const lineCoords = geometry.map((p) => `${p.lng} ${p.lat}`).join(',');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT COUNT(*)::int AS count
       FROM hazard_reports hr
       WHERE hr.is_active = true AND hr.expires_at > NOW()
         AND ST_DWithin(
           hr.location::geography,
           ST_GeomFromText('LINESTRING(${lineCoords})', 4326)::geography,
           500
         )`,
    );
    return (rows as Array<{ count: number }>)[0]?.count ?? 0;
  }

  private async avgQualityAlongGeometry(
    geometry: Array<{ lat: number; lng: number }>,
  ): Promise<number | null> {
    if (geometry.length < 2) return null;

    const lineCoords = geometry.map((p) => `${p.lng} ${p.lat}`).join(',');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.routeRepo.query(
      `SELECT AVG(rs.quality_score)::float AS avg_quality
       FROM road_segments rs
       WHERE rs.quality_score IS NOT NULL
         AND ST_DWithin(
           rs.geom::geography,
           ST_GeomFromText('LINESTRING(${lineCoords})', 4326)::geography,
           100
         )`,
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
