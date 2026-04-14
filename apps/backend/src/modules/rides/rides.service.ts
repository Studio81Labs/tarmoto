import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { StartRideDto } from './dto/start-ride.dto.js';
import { ListRidesDto } from './dto/list-rides.dto.js';
import {
  RideResponseDto,
  RideSummaryDto,
  RideDetailDto,
  RideListResponseDto,
} from './dto/ride-response.dto.js';

@Injectable()
export class RidesService {
  constructor(
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStats)
    private readonly statsRepo: Repository<RideStats>,
    @InjectRepository(RideSegment)
    private readonly segmentRepo: Repository<RideSegment>,
  ) {}

  async start(userId: string, dto: StartRideDto): Promise<RideResponseDto> {
    // Check for existing active ride
    const active = await this.rideRepo.findOne({
      where: { user_id: userId, status: 'active' },
    });
    if (active) {
      throw new BadRequestException(
        'You already have an active ride. Stop it before starting a new one.',
      );
    }

    const ride = this.rideRepo.create({
      user_id: userId,
      ride_type: dto.ride_type ?? 'free',
      started_at: new Date(),
      status: 'active',
    });

    const saved = await this.rideRepo.save(ride);
    return this.toRideResponse(saved);
  }

  async stop(userId: string, rideId: string): Promise<RideResponseDto> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    if (ride.status !== 'active') {
      throw new BadRequestException('Ride is not active');
    }

    ride.status = 'completed';
    ride.ended_at = new Date();

    const saved = await this.rideRepo.save(ride);
    return this.toRideResponse(saved);
  }

  async list(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideListResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const qb = this.rideRepo
      .createQueryBuilder('ride')
      .where('ride.user_id = :userId', { userId })
      .orderBy('ride.started_at', 'DESC')
      .skip(offset)
      .take(limit);

    if (query.type) {
      qb.andWhere('ride.ride_type = :type', { type: query.type });
    }

    const [rides, total] = await qb.getManyAndCount();

    return {
      rides: rides.map((r) => this.toSummaryDto(r)),
      total,
    };
  }

  async getDetail(userId: string, rideId: string): Promise<RideDetailDto> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    // Load stats and segments in parallel
    const [stats, segments] = await Promise.all([
      this.statsRepo.findOne({ where: { ride_id: rideId } }),
      this.segmentRepo.find({
        where: { ride_id: rideId },
        relations: ['road_segment'],
        order: { sequence: 'ASC' },
      }),
    ]);

    // Convert route geometry
    let routeGeometry: Array<{ lat: number; lng: number }> | null = null;
    if (ride.route_geom) {
      const geom = ride.route_geom as unknown as {
        coordinates: number[][];
      };
      if (geom.coordinates) {
        routeGeometry = geom.coordinates.map((c) => ({
          lat: c[1],
          lng: c[0],
        }));
      }
    }

    const durationMin = this.calcDurationMin(ride);

    return {
      id: ride.id,
      status: ride.status,
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      max_speed: ride.max_speed,
      avg_road_quality: ride.avg_road_quality,
      duration_min: durationMin,
      route_geometry: routeGeometry,
      elevation_gain: stats?.elevation_gain ?? null,
      elevation_loss: stats?.elevation_loss ?? null,
      curve_count: stats?.curve_count ?? null,
      max_lean_angle: stats?.max_lean_angle ?? null,
      fuel_estimate_l: stats?.fuel_estimate_l ?? null,
      segments: segments.map((s) => ({
        road_segment_id: s.road_segment_id,
        road_name: s.road_segment?.road_name ?? null,
        quality_reading: s.quality_reading,
        speed_avg: s.speed_avg,
        lean_angle_max: s.lean_angle_max,
      })),
    };
  }

  async exportGpx(userId: string, rideId: string): Promise<string> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    if (!ride.route_geom) {
      throw new BadRequestException('Ride has no recorded route');
    }

    const geom = ride.route_geom as unknown as { coordinates: number[][] };
    const points = geom.coordinates
      .map((c) => `      <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>`)
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tarmoto">
  <trk>
    <name>Tarmoto Ride ${ride.started_at.toISOString().slice(0, 10)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  }

  private toRideResponse(ride: Ride): RideResponseDto {
    return {
      id: ride.id,
      status: ride.status,
      ride_type: ride.ride_type,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
    };
  }

  private toSummaryDto(ride: Ride): RideSummaryDto {
    return {
      ...this.toRideResponse(ride),
      duration_min: this.calcDurationMin(ride),
    };
  }

  private calcDurationMin(ride: Ride): number | null {
    if (!ride.ended_at) return null;
    return Math.round(
      (ride.ended_at.getTime() - ride.started_at.getTime()) / 60000,
    );
  }
}
