import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { pointToLatLng } from '@tarmoto/shared';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import {
  CreateCommuteRouteDto,
  CommuteRouteResponseDto,
  CommuteStatusResponseDto,
  CommuteStatsResponseDto,
} from './dto/commute.dto.js';

const FUEL_L_PER_KM = 0.05; // ~5L/100km average motorcycle

@Injectable()
export class CommuteService {
  constructor(
    @InjectRepository(CommuteRoute)
    private readonly routeRepo: Repository<CommuteRoute>,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
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
    // New route becomes primary; unset primary on all existing routes
    await this.routeRepo.update(
      { user_id: userId, is_primary: true },
      { is_primary: false },
    );

    const route = this.routeRepo.create({
      user_id: userId,
      name: dto.name ?? 'Default',
      is_primary: true,
      origin: {
        type: 'Point',
        coordinates: [dto.origin.lng, dto.origin.lat],
      },
      destination: {
        type: 'Point',
        coordinates: [dto.destination.lng, dto.destination.lat],
      },
    });

    const saved = await this.routeRepo.save(route);
    return this.toRouteResponse(saved);
  }

  async deleteRoute(userId: string, routeId: string): Promise<void> {
    const route = await this.routeRepo.findOne({
      where: { id: routeId, user_id: userId },
    });
    if (!route) {
      throw new NotFoundException('Commute route not found');
    }
    await this.routeRepo.remove(route);
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
