import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { randomBytes } from 'node:crypto';
import type { RideType } from '@tarmoto/shared';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Bike } from '../../entities/bike.entity.js';
import { PrivacyPreferencesService } from '../account/privacy-preferences.service.js';
import { BikesService } from '../bikes/bikes.service.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { StartRideDto } from './dto/start-ride.dto.js';
import { ListRidesDto } from './dto/list-rides.dto.js';
import {
  RideResponseDto,
  RideSummaryDto,
  RideDetailDto,
  RideListResponseDto,
  RideTracksResponseDto,
  type RideStatus,
} from './dto/ride-response.dto.js';
import { RideStatsDto } from './dto/ride-stats.dto.js';
import {
  RideBreakdownDto,
  RideBreakdownSliceDto,
} from './dto/ride-breakdown.dto.js';
import { CsvService } from './csv.service.js';
import { stripAdvancedRideStats } from './advanced-ride-stats.js';
import {
  isFeatureEnabled,
  normalizeLeanDistribution,
  SURFACE_TYPES,
} from '@tarmoto/shared';

// How many ride-route geometries the "My rides" map overlay returns at once.
// Hard-capped at 500 to bound the geospatial query + payload; tunable downward
// via `TARMOTO_RIDE_OVERLAY_LIMIT` (e.g. to keep the overlay calmer for very
// active riders). Clamped to [1, 500]; non-numeric/unset falls back to 500.
const RIDE_OVERLAY_CAP = (() => {
  const raw = Number(process.env.TARMOTO_RIDE_OVERLAY_LIMIT);
  const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
  return Math.min(500, Math.max(1, value));
})();

// Curviness bands over the canonical 0–5 `road_segments.curviness_score`
// scale (the same scale the fun-zone clustering uses: `>= 3.0`, `/ 5.0`).
// The SQL `CASE` in `breakdown()` mirrors these boundaries exactly.
const CURVINESS_BANDS: ReadonlyArray<{ key: string }> = [
  { key: 'straight' },
  { key: 'flowing' },
  { key: 'twisty' },
  { key: 'tight' },
  { key: 'hairpin' },
];

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideStats)
    private readonly statsRepo: Repository<RideStats>,
    @InjectRepository(RideSegment)
    private readonly segmentRepo: Repository<RideSegment>,
    @InjectRepository(SharedRide)
    private readonly sharedRideRepo: Repository<SharedRide>,
    @InjectRepository(Bike)
    private readonly bikeRepo: Repository<Bike>,
    private readonly csvService: CsvService,
    private readonly privacy: PrivacyPreferencesService,
    private readonly bikesService: BikesService,
    private readonly featureResolver: FeatureResolver,
  ) {}

  async start(userId: string, dto: StartRideDto): Promise<RideResponseDto> {
    const bikeId = await this.resolveBikeId(userId, dto.bike_id);

    const ride = this.rideRepo.create({
      user_id: userId,
      ride_type: dto.ride_type ?? 'free',
      started_at: new Date(),
      status: 'active',
      bike_id: bikeId,
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

    // #279 — apply the rider's default sharing preference. When the
    // preference is `public`, create a shared_ride row at finish time so
    // the ride immediately surfaces in the community feed. `private`
    // (the default) is a no-op — the rider can still publish ad-hoc via
    // `POST /rides/:rideId/share`. Failures here MUST stay non-fatal:
    // the ride is already saved as `completed` above and the caller
    // (mobile) treats a 500 from `stop` as "ride didn't finish",
    // which would prompt a misleading retry. Auto-share is a
    // best-effort enhancement; the rider can still publish manually if
    // it didn't take.
    try {
      await this.applyDefaultRideSharing(userId, saved.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `auto-share for ride ${saved.id} (user ${userId}) failed: ${msg}`,
      );
    }

    return this.toRideResponse(saved);
  }

  private async applyDefaultRideSharing(
    userId: string,
    rideId: string,
  ): Promise<void> {
    if (
      !(await this.featureResolver.isSystemSwitchEnabled('sys_ride_publishing'))
    ) {
      return; // auto-publish disabled — leave the ride private
    }

    const prefs = await this.privacy.loadPreferences(userId);
    if (prefs.default_ride_sharing !== 'public') return;

    // Idempotent on `ride_id` via the unique index `idx_shared_rides_ride`.
    // The findOne pre-check covers the common case (no concurrent stop);
    // the catch on `save` handles the race where two concurrent finishes
    // both pass the pre-check and the second hits the unique-violation.
    // Either path leaves exactly one share row for the ride.
    const existing = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId },
    });
    if (existing) return;

    try {
      await this.sharedRideRepo.save(
        this.sharedRideRepo.create({
          ride_id: rideId,
          user_id: userId,
          share_token: randomBytes(16).toString('hex'),
          is_public: true,
        }),
      );
    } catch (err) {
      // Postgres unique-violation on `ride_id` — another stop won the
      // race and already created the row. Treat as success.
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        return;
      }
      throw err;
    }
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
      // OneToOne — surfaces `ride.stats.max_lean_angle` on the summary so the
      // Ride History table can show a LEAN column without a per-ride detail
      // fetch. A LEFT JOIN keeps rides without stats in the result, and being
      // OneToOne it can't multiply rows or inflate the getManyAndCount total.
      .leftJoinAndSelect('ride.stats', 'stats')
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

    // advanced_ride_stats (Pro) — gate the summary's max_lean_angle for a
    // viewer who lacks the entitlement. Resolved once per page rather than
    // per ride.
    const features = await this.featureResolver.resolveForUser(userId);
    const gated = !isFeatureEnabled(features, 'advanced_ride_stats');
    const summaries = rides.map((r) => {
      const summary = this.toSummary(r);
      return gated ? stripAdvancedRideStats(summary) : summary;
    });

    return {
      rides: summaries,
      total,
    };
  }

  /**
   * Aggregate KPIs for the SAME filtered set as `list()` — drives the Ride
   * History "All rides" cards so they track the active filter window. Runs
   * two raw aggregates in parallel, both routed through `applyRidesFilters`
   * so the WHERE clause matches the list exactly: a single-row scalar
   * aggregate (distance / hours / weighted quality / count) on `rides`, plus
   * a distinct-road-segment count that needs the `ride_segments` join.
   * Splitting the distinct-roads count out keeps the scalar aggregate from
   * fanning out across the one-to-many join (which would inflate SUM/COUNT).
   */
  async stats(userId: string, query: ListRidesDto): Promise<RideStatsDto> {
    const base = (): SelectQueryBuilder<Ride> =>
      this.applyRidesFilters(
        this.rideRepo
          .createQueryBuilder('ride')
          .where('ride.user_id = :userId', { userId }),
        query,
      );

    const [agg, roadsRow] = await Promise.all([
      base()
        .select('COALESCE(SUM(ride.distance_km), 0)', 'km')
        .addSelect(
          'COALESCE(SUM(EXTRACT(EPOCH FROM (ride.ended_at - ride.started_at)) / 3600.0), 0)',
          'hours',
        )
        .addSelect(
          'CASE WHEN SUM(ride.distance_km) FILTER (WHERE ride.avg_road_quality IS NOT NULL) > 0 ' +
            'THEN SUM(ride.avg_road_quality * ride.distance_km) ' +
            '/ SUM(ride.distance_km) FILTER (WHERE ride.avg_road_quality IS NOT NULL) ' +
            'ELSE AVG(ride.avg_road_quality) END',
          'quality',
        )
        .addSelect('COUNT(*)', 'count')
        .getRawOne<{
          km: string;
          hours: string;
          quality: string | null;
          count: string;
        }>(),
      // Distinct road segments ridden by rides matching the filter. For a
      // windowed filter this is "roads ridden in the window", NOT first-time
      // discoveries — a road first ridden last year and repeated this month
      // still counts. The companion labels this KPI "Roads / RIDDEN" rather
      // than "discovered" so it doesn't overstate exploration. (A true
      // first-discovery count would need MIN(started_at) per segment across
      // all the user's rides, gated on the window — left as a follow-up.)
      base()
        .innerJoin('ride_segments', 'seg', 'seg.ride_id = ride.id')
        .select('COUNT(DISTINCT seg.road_segment_id)', 'roads')
        .andWhere('seg.road_segment_id IS NOT NULL')
        .getRawOne<{ roads: string }>(),
    ]);

    // Return the raw numeric aggregates — rounding here would report
    // materially wrong totals for filter windows of short rides (a 20-minute
    // ride floors to 0 hours; a 0.4 km commute floors to 0 km) even though
    // matching rides exist. The client (RideKpiCards) rounds/formats for
    // display. new_roads and ride_count are genuine integer counts.
    return {
      total_distance_km: parseFloat(agg?.km ?? '0'),
      total_hours: parseFloat(agg?.hours ?? '0'),
      new_roads: parseInt(roadsRow?.roads ?? '0', 10),
      avg_quality: agg?.quality != null ? parseFloat(agg.quality) : null,
      ride_count: parseInt(agg?.count ?? '0', 10),
    };
  }

  /**
   * Distance-weighted surface + curviness breakdown for the SAME filtered set
   * as `list()`/`stats()`. Derived live from the rides' snapped segments
   * (`ride_segments → road_segments`) rather than persisted on `ride_stats`,
   * so a later correction to a segment's `surface_type` / `curviness_score`
   * is reflected automatically and there's nothing to backfill. Each grouped
   * aggregate runs over the `length_m` of the road segments the rides crossed.
   */
  async breakdown(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideBreakdownDto> {
    // Base query matching the active filter, joined to the snapped road
    // segments. INNER joins drop rides/segments without a linked road segment,
    // which is exactly what "distance ridden on known roads" should measure.
    const base = (): SelectQueryBuilder<Ride> =>
      this.applyRidesFilters(
        this.rideRepo
          .createQueryBuilder('ride')
          .where('ride.user_id = :userId', { userId }),
        query,
      )
        .innerJoin('ride_segments', 'seg', 'seg.ride_id = ride.id')
        .innerJoin('road_segments', 'road', 'road.id = seg.road_segment_id');

    // Mirrors CURVINESS_BANDS on the canonical 0–5 curviness_score scale.
    const curvinessCase = `CASE
        WHEN road.curviness_score < 1 THEN 'straight'
        WHEN road.curviness_score < 2 THEN 'flowing'
        WHEN road.curviness_score < 3 THEN 'twisty'
        WHEN road.curviness_score < 4 THEN 'tight'
        ELSE 'hairpin'
      END`;

    const [surfaceRows, curvinessRows] = await Promise.all([
      base()
        // `surface_type` can be NULL (the aggregation pipeline preserves it
        // when no surface mode exists); fold those metres into "unknown" so
        // they stay visible and the slices still sum to the total distance.
        .select("COALESCE(road.surface_type, 'unknown')", 'key')
        .addSelect('COALESCE(SUM(road.length_m), 0)', 'meters')
        .groupBy("COALESCE(road.surface_type, 'unknown')")
        .getRawMany<{ key: string; meters: string }>(),
      base()
        .select(curvinessCase, 'key')
        .addSelect('COALESCE(SUM(road.length_m), 0)', 'meters')
        .groupBy(curvinessCase)
        .getRawMany<{ key: string; meters: string }>(),
    ]);

    const metersByKey = (
      rows: Array<{ key: string; meters: string }>,
    ): Map<string, number> =>
      new Map(rows.map((r) => [r.key, parseFloat(r.meters) || 0]));

    const surfaceMeters = metersByKey(surfaceRows);
    const curvinessMeters = metersByKey(curvinessRows);

    const totalMeters = [...surfaceMeters.values()].reduce((a, b) => a + b, 0);

    if (totalMeters <= 0) {
      return { surface: [], curviness: [], total_meters: 0 };
    }

    const toSlice = (key: string, meters: number): RideBreakdownSliceDto => ({
      key,
      meters,
      // One-decimal percentage; the client renders the bar/legend verbatim.
      pct: Math.round((meters / totalMeters) * 1000) / 10,
    });

    // Surface: canonical order, omit surfaces with no distance ridden.
    const surface = SURFACE_TYPES.flatMap((key) => {
      const meters = surfaceMeters.get(key) ?? 0;
      return meters > 0 ? [toSlice(key, meters)] : [];
    });

    // Curviness: return the full straight→hairpin ladder so empty bands still
    // render their 0% rung.
    const curviness = CURVINESS_BANDS.map((band) =>
      toSlice(band.key, curvinessMeters.get(band.key) ?? 0),
    );

    return { surface, curviness, total_meters: totalMeters };
  }

  async getDetail(userId: string, rideId: string): Promise<RideDetailDto> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId },
      relations: { user: true },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    const isOwner = ride.user_id === userId;
    // Resolve the ride's share (one row per ride). The owner gets its token
    // even for a link-only (non-public) share so they can copy a working
    // no-auth link; a non-owner is gated on `is_public` (the feed visibility).
    const share = await this.sharedRideRepo.findOne({
      where: { ride_id: rideId },
      select: ['id', 'share_token', 'is_public'],
    });
    if (!isOwner) {
      // Non-owners may view a ride only when its owner has publicly shared it,
      // isn't private, and isn't mid-deletion — exactly the visibility the
      // community feed and token read path enforce (`user.deleted_at IS NULL`).
      // Anything else 404s so we never leak a ride's existence.
      const ownerPrefs = await this.privacy.loadPreferences(ride.user_id);
      if (
        !share?.is_public ||
        ownerPrefs.profile_visibility === 'private' ||
        ride.user?.deleted_at != null
      ) {
        throw new NotFoundException('Ride not found');
      }
      // Count the visit like the token read path does, so the community
      // popularity sort/filter stay accurate now that the feed card links
      // here instead of `/rides/shared/:token`.
      await this.sharedRideRepo.increment({ id: share.id }, 'view_count', 1);
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
        routeGeometry = geom.coordinates.map(([lng, lat]) => {
          if (lng === undefined || lat === undefined) {
            throw new Error('ride geometry coordinate is missing lng/lat');
          }
          return { lat, lng };
        });
      }
    }

    const durationMin = this.calcDurationMin(ride);

    const detail: RideDetailDto = {
      id: ride.id,
      status: ride.status as RideStatus,
      ride_type: ride.ride_type as RideType,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      max_speed: ride.max_speed,
      avg_road_quality: ride.avg_road_quality,
      avg_curviness: ride.avg_curviness ?? null,
      bike_id: ride.bike_id ?? null,
      name: ride.name ?? null,
      duration_min: durationMin,
      route_geometry: routeGeometry,
      elevation_gain: stats?.elevation_gain ?? null,
      elevation_loss: stats?.elevation_loss ?? null,
      curve_count: stats?.curve_count ?? null,
      max_lean_angle: stats?.max_lean_angle ?? null,
      // Normalise the JSONB blob through the shared helper so a stored
      // row that's missing a bucket key (older write, hand-edited
      // migration) still produces a complete distribution; return null
      // verbatim when no samples were ever captured so the client can
      // distinguish "uncomputed" from "all zeros".
      lean_distribution: stats?.lean_distribution_json
        ? normalizeLeanDistribution(stats.lean_distribution_json)
        : null,
      fuel_estimate_l: stats?.fuel_estimate_l ?? null,
      segments: segments.map((s) => ({
        road_segment_id: s.road_segment_id,
        road_name: s.road_segment?.road_name ?? null,
        quality_reading: s.quality_reading,
        speed_avg: s.speed_avg,
        speed_max: s.speed_max,
        lean_angle_max: s.lean_angle_max,
      })),
      viewer_is_owner: isOwner,
      rider_id: ride.user_id,
      rider_name: ride.user?.display_name ?? '',
      rider_avatar_url: ride.user?.avatar_url ?? null,
      share_token: share?.share_token ?? null,
    };

    // advanced_ride_stats (Pro) — gated on the REQUESTING viewer's
    // entitlement (`userId`), not the ride owner's.
    const features = await this.featureResolver.resolveForUser(userId);
    if (!isFeatureEnabled(features, 'advanced_ride_stats')) {
      return stripAdvancedRideStats(detail);
    }
    return detail;
  }

  async rename(
    userId: string,
    rideId: string,
    name: string | null | undefined,
  ): Promise<RideSummaryDto> {
    // Hydrate `stats` so the returned summary carries the real
    // `max_lean_angle` — `RideSummaryDto` documents it, and clients that
    // refresh their row from the PATCH response would otherwise drop the
    // LEAN value to null until a full list/detail refetch.
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
      relations: { stats: true },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    // Resolve the entitlement BEFORE mutating/saving. If `resolveForUser`
    // fails (transient pool/db error), a resolve-after-save would already have
    // committed the rename yet return an error, so a retrying client sees a
    // "failed" mutation that actually took effect. Resolving first keeps the
    // rename and its response consistent: either both happen or neither does.
    const features = await this.featureResolver.resolveForUser(userId);

    const trimmed = typeof name === 'string' ? name.trim() : '';
    ride.name = trimmed.length > 0 ? trimmed : null;
    const saved = await this.rideRepo.save(ride);
    // `save` may return a fresh instance without the eager-loaded relation;
    // carry it over so `toSummary` reads the hydrated stats.
    saved.stats = ride.stats;
    const summary = this.toSummary(saved);

    // advanced_ride_stats (Pro) — the hydration above intentionally carries
    // the real max_lean_angle through `save`, so gate it here the same way
    // list()/getDetail() do rather than skipping the hydration.
    if (!isFeatureEnabled(features, 'advanced_ride_stats')) {
      return stripAdvancedRideStats(summary);
    }
    return summary;
  }

  async getTracks(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideTracksResponseDto> {
    const CAP = RIDE_OVERLAY_CAP;
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
    // advanced_ride_stats (Pro) — CSV export itself stays free; gate only the
    // advanced column VALUES (elevation_gain/loss, max_lean_angle) so a
    // non-entitled rider can't bypass the paywall via the export path.
    const includeAdvanced = await this.hasAdvancedRideStats(userId);
    // Same reasoning one flag over: the export stays available, only the
    // killed metric's VALUE is withheld. The companion gates every surface
    // that renders it, so leaving it in the CSV would be a way around them.
    const includeQuality = await this.hasRoadQualityOverlay(userId);
    return this.csvService.buildRideCsv(
      ride,
      stats,
      includeAdvanced,
      includeQuality,
    );
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

    const includeAdvanced = await this.hasAdvancedRideStats(userId);
    const includeQuality = await this.hasRoadQualityOverlay(userId);
    return this.csvService.buildRidesCsv(
      rides.map((ride) => ({
        ride,
        stats: statsByRideId.get(ride.id) ?? null,
      })),
      includeAdvanced,
      includeQuality,
    );
  }

  private async hasAdvancedRideStats(userId: string): Promise<boolean> {
    const features = await this.featureResolver.resolveForUser(userId);
    return isFeatureEnabled(features, 'advanced_ride_stats');
  }

  private async hasRoadQualityOverlay(userId: string): Promise<boolean> {
    const features = await this.featureResolver.resolveForUser(userId);
    return isFeatureEnabled(features, 'road_quality_overlay');
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
      status: ride.status as RideStatus,
      ride_type: ride.ride_type as RideType,
      started_at: ride.started_at.toISOString(),
      ended_at: ride.ended_at?.toISOString() ?? null,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      avg_road_quality: ride.avg_road_quality,
      avg_curviness: ride.avg_curviness ?? null,
      bike_id: ride.bike_id ?? null,
    };
  }

  /**
   * Resolve which bike a `/rides/start` request should be tagged with.
   *
   *   - Explicit `bike_id` in the payload: validate ownership and use
   *     it. Cross-user IDs are rejected as 400 so a stray client never
   *     attaches one rider's ride to another rider's bike.
   *   - Omitted: fall back to the rider's currently active bike (or
   *     null if they haven't added any yet — legacy rides also keep
   *     `bike_id = null`).
   */
  private async resolveBikeId(
    userId: string,
    requestedBikeId: string | undefined,
  ): Promise<string | null> {
    if (requestedBikeId) {
      const owned = await this.bikeRepo.findOne({
        where: { id: requestedBikeId, user_id: userId },
      });
      if (!owned) {
        throw new BadRequestException('Bike not found in your garage');
      }
      return owned.id;
    }
    const active = await this.bikesService.findActive(userId);
    return active?.id ?? null;
  }

  toSummary(ride: Ride): RideSummaryDto {
    return {
      ...this.toRideResponse(ride),
      name: ride.name ?? null,
      duration_min: this.calcDurationMin(ride),
      // Optional-chains so callers that don't hydrate `stats` (e.g. importGpx)
      // safely yield null rather than crashing.
      max_lean_angle: ride.stats?.max_lean_angle ?? null,
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
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.started_to)) {
        // Date-only (the rides-list date picker) means inclusive end-of-day:
        // add one day and compare with `<`.
        const to = new Date(query.started_to);
        to.setUTCDate(to.getUTCDate() + 1);
        qb.andWhere('ride.started_at < :started_to_excl', {
          started_to_excl: to.toISOString(),
        });
      } else {
        // A full ISO timestamp (the home recent-rides hook capping at "now")
        // is an exact instant upper bound — `<=`, without the +1-day
        // end-of-day widening, so a future-dated ride can't slip past a
        // "now" cap and starve the recent-rides window.
        qb.andWhere('ride.started_at <= :started_to_instant', {
          started_to_instant: new Date(query.started_to).toISOString(),
        });
      }
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
