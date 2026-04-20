import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
import { CsvService } from './csv.service.js';

@Injectable()
export class RidesService {
  constructor(
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStats)
    private readonly statsRepo: Repository<RideStats>,
    @InjectRepository(RideSegment)
    private readonly segmentRepo: Repository<RideSegment>,
    private readonly csvService: CsvService,
  ) {}

  async start(userId: string, dto: StartRideDto): Promise<RideResponseDto> {
    const ride = this.rideRepo.create({
      user_id: userId,
      ride_type: dto.ride_type ?? 'free',
      started_at: new Date(),
      status: 'active',
    });

    let saved: Ride;
    try {
      saved = await this.rideRepo.save(ride);
    } catch (err: unknown) {
      // Partial unique index: idx_rides_one_active_per_user
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new BadRequestException(
          'You already have an active ride. Stop it before starting a new one.',
        );
      }
      throw err;
    }

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
      .skip(offset)
      .take(limit);

    if (query.type) {
      qb.andWhere('ride.ride_type = :type', { type: query.type });
    }
    if (query.started_from) {
      qb.andWhere('ride.started_at >= :started_from', {
        started_from: query.started_from,
      });
    }
    if (query.started_to) {
      // inclusive end-of-day — add one day, compare with <
      const to = new Date(query.started_to);
      to.setUTCDate(to.getUTCDate() + 1);
      qb.andWhere('ride.started_at < :started_to_excl', {
        started_to_excl: to.toISOString(),
      });
    }
    if (query.min_distance_km !== undefined) {
      qb.andWhere('ride.distance_km >= :min_distance_km', {
        min_distance_km: query.min_distance_km,
      });
    }
    if (query.max_distance_km !== undefined) {
      qb.andWhere('ride.distance_km <= :max_distance_km', {
        max_distance_km: query.max_distance_km,
      });
    }
    if (query.min_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality >= :min_quality', {
        min_quality: query.min_quality,
      });
    }
    if (query.max_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality <= :max_quality', {
        max_quality: query.max_quality,
      });
    }
    if (query.q) {
      qb.andWhere('ride.name ILIKE :q', { q: `%${query.q}%` });
    }

    const sortField = query.sort ?? 'started_at';
    const order = (query.order ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
    // duration_min is derived (ended_at - started_at); sort via started_at as
    // a proxy when sort=duration_min is requested — ride lengths in minutes
    // aren't stored on the ride row, so DB-side sort by the literal field
    // isn't available without a computed column. Spec calls this out as
    // acceptable for v1.
    const column = sortField === 'duration_min' ? 'started_at' : sortField;
    qb.orderBy(`ride.${column}`, order);

    const [rides, total] = await qb.getManyAndCount();

    return {
      rides: rides.map((r) => this.toSummary(r)),
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
      name: ride.name ?? null,
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

  async rename(
    userId: string,
    rideId: string,
    name: string | null | undefined,
  ): Promise<RideSummaryDto> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    const trimmed = typeof name === 'string' ? name.trim() : '';
    ride.name = trimmed.length > 0 ? trimmed : null;
    const saved = await this.rideRepo.save(ride);
    return this.toSummary(saved);
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

    return this.wrapGpx([this.rideToTrack(ride)]);
  }

  async exportRideCsv(userId: string, rideId: string): Promise<string> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    const stats = await this.statsRepo.findOne({ where: { ride_id: rideId } });
    return this.csvService.buildRideCsv(ride, stats);
  }

  async exportAllCsv(userId: string): Promise<string> {
    const rides = await this.rideRepo.find({
      where: { user_id: userId },
      order: { started_at: 'DESC' },
    });
    const rideIds = rides.map((r) => r.id);
    const statsRows = rideIds.length
      ? await this.statsRepo.find({ where: { ride_id: In(rideIds) } })
      : [];
    const statsByRideId = new Map(statsRows.map((s) => [s.ride_id, s]));

    return this.csvService.buildRidesCsv(
      rides.map((ride) => ({
        ride,
        stats: statsByRideId.get(ride.id) ?? null,
      })),
    );
  }

  async exportAllGpx(userId: string): Promise<string> {
    const rides = await this.rideRepo.find({
      where: { user_id: userId },
      order: { started_at: 'DESC' },
    });
    const tracks = rides
      .filter((r) => r.route_geom)
      .map((r) => this.rideToTrack(r));
    return this.wrapGpx(tracks);
  }

  private rideToTrack(ride: Ride): string {
    const geom = ride.route_geom as unknown as { coordinates: number[][] };
    const points = geom.coordinates
      .map((c) => `      <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>`)
      .join('\n');
    return `  <trk>
    <name>Tarmoto Ride ${ride.started_at.toISOString().slice(0, 10)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>`;
  }

  private wrapGpx(tracks: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tarmoto">
${tracks.join('\n')}
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

  toSummary(ride: Ride): RideSummaryDto {
    return {
      ...this.toRideResponse(ride),
      name: ride.name ?? null,
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
