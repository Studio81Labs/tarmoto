import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
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
  RideTracksResponseDto,
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
    // Recompute the length-weighted curviness aggregate now that the
    // ride is terminal. Source data (`road_segments.curviness_score`,
    // `length_m`) is backend-owned, so this can't live on the mobile
    // upload. Runs post-save so `saved` can mirror the updated value
    // without round-tripping a re-select.
    saved.avg_curviness = await this.recomputeAvgCurviness(saved.id);
    return this.toRideResponse(saved);
  }

  /**
   * Length-weighted average of `road_segments.curviness_score` over the
   * ride's `ride_segments`. Returns `null` when the ride has no snapped
   * segments yet (fresh completion before upload finished) or when every
   * segment is degenerate (`length_m = 0`), so the column stays NULL
   * and the `curviest` sort's `NULLS LAST` pushes it to the bottom
   * rather than pretending the ride scored zero.
   */
  private async recomputeAvgCurviness(rideId: string): Promise<number | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rows = await this.rideRepo.query(
      `SELECT
         CASE
           WHEN SUM(rs.length_m) > 0
             THEN SUM(rs.curviness_score * rs.length_m) / SUM(rs.length_m)
           ELSE NULL
         END AS weighted_avg
       FROM ride_segments rseg
       JOIN road_segments rs ON rs.id = rseg.road_segment_id
       WHERE rseg.ride_id = $1`,
      [rideId],
    );

    const raw = (rows as Array<{ weighted_avg: number | string | null }>)[0]
      ?.weighted_avg;
    // pg returns FLOAT aggregates as number on this driver config, but
    // guard against the occasional string (numeric-style aggregate) so
    // we don't hand the DTO `"3.25"` and blow up a `min_curviness`
    // comparison on the client side.
    const weightedAvg =
      typeof raw === 'string' ? Number.parseFloat(raw) : (raw ?? null);

    await this.rideRepo.update({ id: rideId }, { avg_curviness: weightedAvg });
    return weightedAvg;
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

    this.applyRidesFilters(qb, query);

    const sortField = query.sort ?? 'started_at';
    const order = (query.order ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
    if (sortField === 'duration_min') {
      // Duration isn't stored — derive via timestamp subtraction. Rides
      // still in progress (ended_at IS NULL) sort to the end in both
      // directions so the open ride doesn't dominate either extreme.
      qb.orderBy('(ride.ended_at - ride.started_at)', order, 'NULLS LAST');
    } else if (
      sortField === 'distance_km' ||
      sortField === 'avg_road_quality'
    ) {
      // Nullable metrics — keep rides with no recorded value at the bottom
      // in both directions so they don't dominate DESC pages.
      qb.orderBy(`ride.${sortField}`, order, 'NULLS LAST');
    } else {
      qb.orderBy(`ride.${sortField}`, order);
    }

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
      avg_curviness: ride.avg_curviness ?? null,
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

  async getTracks(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideTracksResponseDto> {
    const CAP = 500;
    const SIMPLIFY_TOLERANCE_DEG = 0.0005; // ~50 m at mid-latitudes

    // Build two independent query builders: one for the geometry-bearing
    // rows (has .select/.addSelect + order + limit) and one for the count
    // (plain shape — avoids any ambiguity around getCount() wrapping the
    // LIMIT'd raw query as a subquery, and avoids evaluating the expensive
    // ST_SimplifyPreserveTopology expression for the count path).
    const baseWhere = (
      qb: SelectQueryBuilder<Ride>,
    ): SelectQueryBuilder<Ride> =>
      this.applyRidesFilters(
        qb
          .where('ride.user_id = :userId', { userId })
          .andWhere('ride.route_geom IS NOT NULL'),
        query,
      );

    const dataQb = baseWhere(this.rideRepo.createQueryBuilder('ride'))
      .select('ride.id', 'id')
      .addSelect(
        `ST_AsGeoJSON(ST_SimplifyPreserveTopology(ride.route_geom, ${SIMPLIFY_TOLERANCE_DEG}))`,
        'geometry',
      )
      .orderBy('ride.started_at', 'DESC')
      .limit(CAP);

    const countQb = baseWhere(this.rideRepo.createQueryBuilder('ride'));

    const [rows, totalMatching] = await Promise.all([
      dataQb.getRawMany<{ id: string; geometry: string | null }>(),
      countQb.getCount(),
    ]);

    const tracks = rows.map((r) => ({
      id: r.id,
      geometry: r.geometry
        ? (JSON.parse(r.geometry) as {
            type: 'LineString';
            coordinates: number[][];
          })
        : null,
    }));

    return { tracks, truncated: totalMatching > CAP };
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
      avg_curviness: ride.avg_curviness ?? null,
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

  private applyRidesFilters(
    qb: SelectQueryBuilder<Ride>,
    query: ListRidesDto,
  ): SelectQueryBuilder<Ride> {
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
      // Escape SQL wildcards (%, _, \) so user-typed characters are treated
      // as literals. Parameter binding protects against injection; this only
      // fixes substring-search semantics.
      const escaped = query.q.replace(/[\\%_]/g, '\\$&');
      qb.andWhere('ride.name ILIKE :q', { q: `%${escaped}%` });
    }
    const hasAnyNear =
      query.near_lat !== undefined ||
      query.near_lng !== undefined ||
      query.near_km !== undefined;
    const hasAllNear =
      query.near_lat !== undefined &&
      query.near_lng !== undefined &&
      query.near_km !== undefined;
    if (hasAnyNear && !hasAllNear) {
      // Reject partial input rather than silently no-op the proximity
      // filter — that's a client bug the rider won't notice otherwise,
      // and a ride list that doesn't respect the intended "near" scope
      // would be actively misleading.
      throw new BadRequestException(
        'near_lat, near_lng, and near_km must be supplied together',
      );
    }
    if (hasAllNear) {
      // Cast both sides to geography so ST_DWithin measures in metres
      // across the surface of the earth — no regional projection to pick,
      // accurate enough for touring-range queries (up to a few hundred
      // km). ST_MakePoint returns SRID 0, so we ST_SetSRID(..., 4326)
      // before the cast; otherwise the geography cast raises.
      qb.andWhere(
        `ST_DWithin(ride.route_geom::geography, ST_SetSRID(ST_MakePoint(:near_lng, :near_lat), 4326)::geography, :near_m)`,
        {
          near_lng: query.near_lng,
          near_lat: query.near_lat,
          near_m: query.near_km! * 1000,
        },
      );
    }
    return qb;
  }
}
