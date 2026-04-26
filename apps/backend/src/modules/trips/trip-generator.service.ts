import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { latLngToPoint } from '@tarmoto/shared';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
  type RouteAlternative,
} from '../commute/routing-provider.interface.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { TripsService } from './trips.service.js';
import { GenerateTripResponseDto } from './dto/generate-trip-response.dto.js';
import {
  GenerateTripDto,
  type AllowedSurface,
  type TripGenerationOptionId,
} from './dto/generate-trip.dto.js';
import { TripDayDto, TripWaypointDto } from './dto/trip-response.dto.js';
import {
  buildDayChain,
  chunkDistance,
  clampDailyKm,
  defaultOptionForPreference,
  OPTION_PRESETS,
  type OptionPreset,
  pickAnchors,
  planFuelStopIndices,
  resolveBBox,
  resolveSurfaceFilter,
  scoreRoute,
} from './trip-generator.utils.js';

/**
 * Per-day, per-route metrics aggregated from PostGIS once and reused
 * across all three option scorers (so we only pay one round-trip per
 * candidate route, not three).
 */
interface RouteMetrics {
  avgQuality: number | null;
  curvinessScore: number | null;
  scenicScore: number | null;
  elevationGain: number;
  elevationLoss: number;
  hazardCount: number;
  /** Road-segment lengths grouped by `surface_type`, in **metres**. */
  surfaceMixMetres: Record<string, number>;
}

/**
 * One scored candidate for a given day. The same `Candidate[]` is used
 * across all three option scorers — `scoreRoute` differentiates by
 * applying the preset's weights.
 */
interface Candidate {
  alt: RouteAlternative;
  metrics: RouteMetrics;
}

/**
 * One day, fully resolved for one option preset (route + waypoints +
 * aggregated metrics). The persistence pass writes the selected
 * option's `BuiltDay[]` to `trip_days`/`trip_waypoints`; the
 * unselected options are returned only as preview data.
 */
interface BuiltDay {
  dayNumber: number;
  title: string;
  distanceKm: number;
  durationMin: number;
  avgQuality: number;
  curvinessScore: number;
  scenicScore: number;
  elevationGain: number;
  elevationLoss: number;
  geometry: Array<{ lat: number; lng: number }>;
  waypoints: Array<{
    sequence: number;
    lat: number;
    lng: number;
    name: string | null;
    waypoint_type: string;
    duration_min: number | null;
    notes: string | null;
  }>;
}

/**
 * One option's full plan + summary aggregates. The summary numbers are
 * the km-weighted means used by the response card; persisting them on
 * `trip_days` would denormalise the same number per row, so they're
 * only computed once at response time.
 */
interface BuiltOption {
  preset: OptionPreset;
  days: BuiltDay[];
  totalDistanceKm: number;
  totalDurationMin: number;
  avgQuality: number;
  avgCurviness: number;
  avgScenic: number;
}

/**
 * Buffer (metres) for ST_DWithin queries that intersect a route line
 * with `road_segments`. 100m matches the `commute` module's quality
 * lookup — narrow enough to filter out segments parallel to the route
 * but wide enough to catch the slight offset between OSRM's geometry
 * and our segment table.
 */
const ROAD_BUFFER_M = 100;

/**
 * Same buffer rule as the commute module — half a kilometre captures
 * hazards that are visible from the road without flagging stuff several
 * blocks away.
 */
const HAZARD_BUFFER_M = 500;

/**
 * Buffer (km) for fun-zone overlap. Zones are polygons rather than
 * lines, so we measure overlap of the route with the zone's boundary
 * rather than a perpendicular distance.
 */
const SCENIC_OVERLAP_BUFFER_KM = 0.5;

@Injectable()
export class TripGeneratorService {
  private readonly logger = new Logger(TripGeneratorService.name);

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripMember)
    private readonly memberRepo: Repository<TripMember>,
    private readonly dataSource: DataSource,
    @Inject(ROUTING_PROVIDER)
    private readonly routingProvider: RoutingProvider,
    private readonly tripsService: TripsService,
    private readonly events: EventsGateway,
    private readonly activity: TripActivityService,
  ) {}

  /**
   * Entrypoint: build all three option presets, persist the selected
   * one, and return both the persisted detail and all three option
   * previews so the companion's "compare side-by-side" view (US-34) has
   * everything in a single round-trip.
   */
  async generate(
    userId: string,
    tripId: string,
    dto: GenerateTripDto,
  ): Promise<GenerateTripResponseDto> {
    // Folds "no such trip" and "you're not a member" into one 404 so
    // the endpoint can't be used to enumerate trip ids.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) throw new NotFoundException('Trip not found');

    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    const start = dto.start_location;
    const bbox = resolveBBox(dto.bbox, trip.region, start);

    // Anchors are shared across options so we only need num_days OSRM
    // calls (each with maxAlternatives=3) instead of 3 * num_days. The
    // three option scorers then re-rank the same candidate set.
    //
    // Anchor count: a multi-day loop needs `numDays - 1` overnight
    // points (the last day closes back to start). A 1-day trip still
    // needs **one** anchor — the day's destination — otherwise the
    // chain collapses to a degenerate start→start leg with 0 km.
    const numDays = trip.num_days;
    const dailyTargets = chunkDistance(
      numDays,
      trip.daily_km_min,
      trip.daily_km_max,
      1.0,
    );
    const numAnchors = numDays === 1 ? 1 : numDays - 1;
    const funZones = await this.loadFunZoneCentroids(bbox);
    const anchors = pickAnchors(start, bbox, funZones, numAnchors);
    const chain = buildDayChain(start, anchors, numDays);

    // Per-day candidate sets — one OSRM call per day, scored once per
    // candidate. Run in parallel; days don't depend on each other once
    // the anchor chain is fixed.
    const surfaceFilter = resolveSurfaceFilter(dto.surfaces, dto.avoid_unpaved);
    // Reject the contradictory case (e.g. `surfaces: ['gravel', 'dirt']`
    // + `avoid_unpaved: true`) up front rather than letting it silently
    // collapse to "no candidates → fall back to primary," which would
    // ignore the rider's filter without telling them. The companion's
    // client-side validator already raises this; mirroring the rule
    // here protects direct API callers.
    if (surfaceFilter !== null && surfaceFilter.length === 0) {
      throw new BadRequestException(
        'Selected surface filters conflict with avoid_unpaved',
      );
    }
    const candidatesByDay = await Promise.all(
      chain.map(async (leg) => {
        const candidates = await this.candidatesForLeg(
          leg.from,
          leg.to,
          surfaceFilter,
          trip.min_quality,
        );
        if (candidates.length === 0) {
          // Defensive: if even the primary OSRM route can't be enriched,
          // synthesise a single great-circle "route" so the response
          // still has the right shape rather than 500-ing on a regional
          // OSRM outage.
          return [this.fallbackCandidate(leg.from, leg.to)];
        }
        return candidates;
      }),
    );

    // Build all three option presets from the shared candidate set.
    // The presets bias scoring (and option-level summary numbers) but
    // share the same OSRM-returned alternatives so total cost stays
    // O(num_days) round-trips instead of O(3 * num_days).
    const builtOptions: BuiltOption[] = OPTION_PRESETS.map((preset) =>
      this.buildOption(preset, candidatesByDay, dailyTargets, trip.region),
    );

    // Default selected option from the trip's persisted
    // `road_preference` so callers that don't pick explicitly still get
    // a sensible itinerary biased toward the rider's saved choice.
    // Explicit `dto.option` always wins.
    const selectedId: TripGenerationOptionId =
      dto.option ?? defaultOptionForPreference(trip.road_preference);
    const selected = builtOptions.find((o) => o.preset.id === selectedId);
    if (!selected) {
      // Should be impossible given the DTO @IsIn validator, but type
      // safety still wants a refinement here.
      throw new NotFoundException('Unknown generation option');
    }

    await this.persistSelected(tripId, selected);

    const detail = await this.tripsService.getDetail(userId, tripId);
    this.events.emitToTrip(tripId, 'trip:generated', {
      tripId,
      selected_option: selectedId,
    });
    await this.activity.recordSafe(tripId, userId, 'trip_generated', {
      option: selectedId,
      num_days: numDays,
    });

    return {
      trip: detail,
      selected_option: selectedId,
      options: builtOptions.map((o) =>
        this.toOptionDto(o, o.preset.id === selectedId),
      ),
    };
  }

  // ── candidate generation ──

  private async candidatesForLeg(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    surfaceFilter: AllowedSurface[] | null,
    minQuality: number,
  ): Promise<Candidate[]> {
    let alts: RouteAlternative[];
    try {
      alts = await this.routingProvider.getAlternatives(
        from.lat,
        from.lng,
        to.lat,
        to.lng,
        3,
      );
    } catch (err) {
      this.logger.warn(
        `OSRM call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    if (alts.length === 0) {
      // Empty alternatives is a normal OSRM response on degenerate
      // legs (start ≈ end) — synthesise a degenerate route so the day
      // still resolves rather than failing the whole request.
      alts = [
        {
          distance_km: 0,
          duration_min: 0,
          geometry: [from, to],
        },
      ];
    }

    const candidates: Candidate[] = [];
    for (const alt of alts) {
      if (alt.geometry.length < 2) continue;
      const metrics = await this.aggregateRouteMetrics(alt.geometry);
      // Apply the trip-level quality and per-request surface filters
      // here rather than in SQL: with only a handful of candidates per
      // day, an in-memory drop is simpler than rewriting the spatial
      // join.
      if (metrics.avgQuality !== null && metrics.avgQuality < minQuality) {
        continue;
      }
      if (
        surfaceFilter &&
        Object.keys(metrics.surfaceMixMetres).length > 0 &&
        !isSurfaceMixMostlyAllowed(metrics.surfaceMixMetres, surfaceFilter)
      ) {
        continue;
      }
      candidates.push({ alt, metrics });
    }
    if (candidates.length === 0 && alts[0]?.geometry.length >= 2) {
      // Both filters dropped every candidate. Keep the primary as a
      // last-resort so the day still has something to render — the
      // option summary numbers will reflect the lower quality and the
      // UI can warn the rider.
      const metrics = await this.aggregateRouteMetrics(alts[0].geometry);
      candidates.push({ alt: alts[0], metrics });
    }
    return candidates;
  }

  private fallbackCandidate(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Candidate {
    // Last-resort placeholder used only when even the primary OSRM
    // request errored — keeps the response shape valid.
    return {
      alt: {
        distance_km: 0,
        duration_min: 0,
        geometry: [from, to],
      },
      metrics: {
        avgQuality: null,
        curvinessScore: null,
        scenicScore: null,
        elevationGain: 0,
        elevationLoss: 0,
        hazardCount: 0,
        surfaceMixMetres: {},
      },
    };
  }

  // ── per-option assembly ──

  private buildOption(
    preset: OptionPreset,
    candidatesByDay: ReadonlyArray<ReadonlyArray<Candidate>>,
    baseDailyTargets: ReadonlyArray<number>,
    region: string | null,
  ): BuiltOption {
    // Apply the preset's distance multiplier on top of the trip's own
    // (min+max)/2 average — this is what wires the persisted daily-km
    // bounds into route selection. Each preset still picks from the
    // same OSRM candidate set, but `scoreRoute`'s `distanceFit` term
    // pulls each option toward its own preferred per-day length.
    //
    // Re-clamp after multiplication: scenic's 1.12× could push an
    // already-MAX target past MAX_DAILY_KM, and fastest's 0.88× could
    // pull a MIN target below MIN_DAILY_KM, biasing the distance-fit
    // term toward distances the rest of the system treats as illegal.
    const dailyTargets = baseDailyTargets.map((km) =>
      clampDailyKm(km * preset.distanceMultiplier),
    );
    const days: BuiltDay[] = candidatesByDay.map((candidates, dayIdx) => {
      const targetKm = dailyTargets[dayIdx];
      // Score each candidate exactly once and pick the max — the
      // earlier `reduce` form double-scored the running best on every
      // step (and self-scored the seed against itself on the first
      // step), wasting `2 * candidates.length` calls per day-per-option
      // for no behavioural difference.
      let best = candidates[0];
      let bestScore = scoreRoute(preset, {
        avgQuality: best.metrics.avgQuality,
        curvinessScore: best.metrics.curvinessScore,
        scenicScore: best.metrics.scenicScore,
        durationMin: best.alt.duration_min,
        distanceKm: best.alt.distance_km,
        targetKm,
      });
      for (let i = 1; i < candidates.length; i++) {
        const cand = candidates[i];
        const score = scoreRoute(preset, {
          avgQuality: cand.metrics.avgQuality,
          curvinessScore: cand.metrics.curvinessScore,
          scenicScore: cand.metrics.scenicScore,
          durationMin: cand.alt.duration_min,
          distanceKm: cand.alt.distance_km,
          targetKm,
        });
        if (score > bestScore) {
          best = cand;
          bestScore = score;
        }
      }
      return this.buildDay(
        dayIdx + 1,
        best,
        preset,
        region,
        dayIdx === candidatesByDay.length - 1,
      );
    });

    const totalDistanceKm = days.reduce((sum, d) => sum + d.distanceKm, 0);
    const totalDurationMin = days.reduce((sum, d) => sum + d.durationMin, 0);
    const avgQuality = kmWeightedMean(days, (d) => d.avgQuality);
    const avgCurviness = kmWeightedMean(days, (d) => d.curvinessScore);
    const avgScenic = kmWeightedMean(days, (d) => d.scenicScore);

    return {
      preset,
      days,
      totalDistanceKm: round1(totalDistanceKm),
      totalDurationMin: Math.round(totalDurationMin),
      avgQuality: round1(avgQuality),
      avgCurviness: round1(avgCurviness),
      avgScenic: round1(avgScenic),
    };
  }

  private buildDay(
    dayNumber: number,
    cand: Candidate,
    preset: OptionPreset,
    region: string | null,
    isFinalDay: boolean,
  ): BuiltDay {
    const route = cand.alt.geometry;
    const startPt = route[0];
    const endPt = route[route.length - 1];

    const fuelIndices = planFuelStopIndices(route, cand.alt.distance_km);

    const waypoints: BuiltDay['waypoints'] = [];
    waypoints.push({
      sequence: 1,
      lat: startPt.lat,
      lng: startPt.lng,
      name: dayNumber === 1 ? 'Trip start' : `Day ${dayNumber} start`,
      waypoint_type: 'start',
      duration_min: null,
      notes: null,
    });
    let seq = 2;
    for (const idx of fuelIndices) {
      const p = route[idx];
      waypoints.push({
        sequence: seq++,
        lat: p.lat,
        lng: p.lng,
        name: 'Fuel stop',
        waypoint_type: 'fuel',
        duration_min: 15,
        notes: null,
      });
    }
    // Non-final days end at an overnight stop (rider sleeps there);
    // the final day closes the loop back to the trip start, so the
    // last waypoint is the trip's `end`.
    waypoints.push({
      sequence: seq,
      lat: endPt.lat,
      lng: endPt.lng,
      name: isFinalDay ? null : `Day ${dayNumber} overnight`,
      waypoint_type: isFinalDay ? 'end' : 'hotel',
      duration_min: null,
      notes: null,
    });

    return {
      dayNumber,
      title: buildDayTitle(dayNumber, region, preset),
      distanceKm: round1(cand.alt.distance_km),
      durationMin: Math.round(cand.alt.duration_min),
      avgQuality: round1(cand.metrics.avgQuality ?? 0),
      curvinessScore: round1(cand.metrics.curvinessScore ?? 0),
      scenicScore: round1(cand.metrics.scenicScore ?? 0),
      elevationGain: Math.round(cand.metrics.elevationGain),
      elevationLoss: Math.round(cand.metrics.elevationLoss),
      geometry: route.map((p) => ({ lat: p.lat, lng: p.lng })),
      waypoints,
    };
  }

  // ── PostGIS aggregation along a route ──

  private async aggregateRouteMetrics(
    geometry: ReadonlyArray<{ lat: number; lng: number }>,
  ): Promise<RouteMetrics> {
    const wkt = geometryToWkt(geometry);

    type QualityRow = {
      avg_quality: number | null;
      avg_curviness: number | null;
      elevation_span: number | null;
      total_length_m: number | null;
    };
    type SurfaceRow = { surface_type: string; length_m: number };
    type HazardRow = { count: number };
    type ScenicRow = { avg_scenic: number | null; zone_count: number };

    // One round-trip per metric — could be combined into a CTE later,
    // but for typical day lengths (<500 km) the four queries each return
    // in <50 ms on the index.
    const [qualityRows, surfaceRows, hazardRows, scenicRows] =
      (await Promise.all([
        this.dataSource.query(
          `SELECT
             AVG(rs.quality_score)::float AS avg_quality,
             AVG(rs.curviness_score)::float AS avg_curviness,
             SUM(GREATEST(rs.elevation_max - rs.elevation_min, 0))::float AS elevation_span,
             SUM(rs.length_m)::float AS total_length_m
           FROM road_segments rs
           WHERE rs.quality_score IS NOT NULL
             AND ST_DWithin(
               rs.geom::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )`,
          [wkt, ROAD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT rs.surface_type, SUM(rs.length_m)::float AS length_m
           FROM road_segments rs
           WHERE ST_DWithin(
             rs.geom::geography,
             ST_GeomFromText($1, 4326)::geography,
             $2
           )
           GROUP BY rs.surface_type`,
          [wkt, ROAD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count
           FROM hazard_reports h
           WHERE h.is_active = true AND h.expires_at > NOW()
             AND ST_DWithin(
               h.location::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )`,
          [wkt, HAZARD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT
             AVG(fz.composite_score)::float AS avg_scenic,
             COUNT(*)::int AS zone_count
           FROM fun_zones fz
           WHERE ST_DWithin(
             fz.boundary::geography,
             ST_GeomFromText($1, 4326)::geography,
             $2
           )`,
          [wkt, SCENIC_OVERLAP_BUFFER_KM * 1000],
        ),
      ])) as [QualityRow[], SurfaceRow[], HazardRow[], ScenicRow[]];

    const q: QualityRow | undefined = qualityRows[0];
    const s: ScenicRow | undefined = scenicRows[0];
    const h: HazardRow | undefined = hazardRows[0];
    const surfaceMixMetres: Record<string, number> = {};
    for (const row of surfaceRows) {
      surfaceMixMetres[row.surface_type] = row.length_m;
    }

    // Elevation gain/loss: we don't have a pre-aggregated profile per
    // route, so use the sum of segment elevation spans as an upper-bound
    // proxy — plenty good for a day card and consistent with what the
    // road-segment elevation columns already report. For a loop trip
    // total descent equals total ascent so this is exact; for a one-way
    // day it's an over-estimate. The contract is documented on
    // `TripDayDto.elevation_loss` so mobile/companion consumers know
    // the value mirrors `elevation_gain` until a real elevation profile
    // API lands.
    const elevationSpan = q?.elevation_span ?? 0;
    const elevationGain = elevationSpan;
    const elevationLoss = elevationSpan;

    const avgQuality = q?.avg_quality ?? null;
    const curvinessScore = q?.avg_curviness ?? null;
    const zoneCount = s?.zone_count ?? 0;
    const scenicAvg = s?.avg_scenic ?? null;
    // Map fun-zone aggregate into a 0..100 scenic score with a real
    // gradient. The previous `avgScore * min(count, 4) * 25` formula
    // saturated at 100 for any zone with composite_score >= 4 (US-6
    // produces scores in roughly the 1..10 range), so an option that
    // overlapped one good zone could not be distinguished from one
    // overlapping five great zones — defeating the "scenic sweep"
    // preset's whole job. Split the score into:
    //   • up to 70 points from the *quality* of zones touched
    //     (composite_score normalised against an expected ~10 ceiling)
    //   • up to 30 points from the *count* of distinct zones touched
    //     (capped at 5 so a single high-density region can't dominate)
    // The sum is still clamped to 100 so the value stays comparable to
    // `quality_score`/`curviness_score` in the same weight bands.
    const scenicScore =
      scenicAvg !== null && zoneCount > 0
        ? Math.min(
            100,
            Math.min(scenicAvg, 10) * 7 + Math.min(zoneCount, 5) * 6,
          )
        : 0;
    const hazardCount = h?.count ?? 0;

    return {
      avgQuality,
      curvinessScore,
      scenicScore,
      elevationGain,
      elevationLoss,
      hazardCount,
      surfaceMixMetres,
    };
  }

  private async loadFunZoneCentroids(
    bbox: [number, number, number, number],
  ): Promise<{ lat: number; lng: number }[]> {
    type FzRow = { lat: number; lng: number; composite_score: number };
    const [w, s, e, n] = bbox;
    const rows: FzRow[] = await this.dataSource.query(
      `SELECT
         ST_Y(ST_Centroid(fz.boundary))::float AS lat,
         ST_X(ST_Centroid(fz.boundary))::float AS lng,
         fz.composite_score
       FROM fun_zones fz
       WHERE ST_Intersects(
         fz.boundary,
         ST_MakeEnvelope($1, $2, $3, $4, 4326)
       )
       ORDER BY fz.composite_score DESC NULLS LAST
       LIMIT 25`,
      [w, s, e, n],
    );
    return rows.map((r) => ({ lat: r.lat, lng: r.lng }));
  }

  // ── persistence ──

  private async persistSelected(
    tripId: string,
    option: BuiltOption,
  ): Promise<void> {
    // Single transaction: drop the existing days (cascading their
    // waypoints), insert the new ones, flip the trip's status to
    // `planned`. The unique (trip_id, day_number) index would otherwise
    // reject a second-run of generate before the delete completes.
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(TripDay, { trip_id: tripId });

      for (const day of option.days) {
        const dayRow = manager.create(TripDay, {
          trip_id: tripId,
          day_number: day.dayNumber,
          title: day.title,
          distance_km: day.distanceKm,
          // estimated_time uses pg's `interval` type — pass minutes via
          // the canonical PostgreSQL `n minutes` syntax so the value
          // round-trips through the column verbatim.
          estimated_time: `${day.durationMin} minutes`,
          avg_quality: day.avgQuality,
          curviness_score: day.curvinessScore,
          scenic_score: day.scenicScore,
          elevation_gain: day.elevationGain,
          elevation_loss: day.elevationLoss,
          route_geom: {
            type: 'LineString',
            coordinates: day.geometry.map((p) => [p.lng, p.lat]),
          },
        });
        const savedDay = await manager.save(dayRow);

        for (const w of day.waypoints) {
          const wpRow = manager.create(TripWaypoint, {
            trip_day_id: savedDay.id,
            sequence: w.sequence,
            location: latLngToPoint({ lat: w.lat, lng: w.lng }),
            name: w.name,
            waypoint_type: w.waypoint_type,
            duration_min: w.duration_min,
            notes: w.notes,
          });
          await manager.save(wpRow);
        }
      }

      await manager.update(
        Trip,
        { id: tripId },
        { status: 'planned', updated_at: new Date() },
      );
    });
  }

  // ── DTO mapping ──

  private toOptionDto(option: BuiltOption, selected: boolean) {
    return {
      id: option.preset.id,
      label: option.preset.label,
      summary: option.preset.summary,
      total_distance_km: option.totalDistanceKm,
      total_duration_min: option.totalDurationMin,
      avg_quality: option.avgQuality,
      avg_curviness: option.avgCurviness,
      avg_scenic: option.avgScenic,
      selected,
      days: option.days.map(
        (d): TripDayDto => ({
          // Preview-only days haven't been persisted, so they don't have
          // a database id. The companion's "compare side-by-side" card
          // identifies preview rows by `day_number` + the wrapping
          // option id; an empty string here is unambiguous because real
          // ids are UUIDs.
          id: '',
          day_number: d.dayNumber,
          title: d.title,
          distance_km: d.distanceKm,
          avg_quality: d.avgQuality,
          elevation_gain: d.elevationGain,
          elevation_loss: d.elevationLoss,
          curviness_score: d.curvinessScore,
          scenic_score: d.scenicScore,
          estimated_time_min: d.durationMin,
          route_geometry: d.geometry,
          waypoints: d.waypoints.map(
            (w): TripWaypointDto => ({
              id: '',
              sequence: w.sequence,
              lat: w.lat,
              lng: w.lng,
              name: w.name,
              waypoint_type: w.waypoint_type,
              road_segment_id: null,
              notes: w.notes,
              duration_min: w.duration_min,
            }),
          ),
        }),
      ),
    };
  }
}

function buildDayTitle(
  dayNumber: number,
  region: string | null,
  preset: OptionPreset,
): string {
  const tag = preset.id === 'best-fit' ? '' : ` (${preset.label})`;
  if (region) return `Day ${dayNumber} — ${region}${tag}`;
  return `Day ${dayNumber}${tag}`;
}

function geometryToWkt(
  geometry: ReadonlyArray<{ lat: number; lng: number }>,
): string {
  const coords = geometry
    .map((p) => `${Number(p.lng)} ${Number(p.lat)}`)
    .join(',');
  return `LINESTRING(${coords})`;
}

function kmWeightedMean(
  days: ReadonlyArray<{ distanceKm: number }>,
  pick: (d: BuiltDay) => number,
): number {
  let totalKm = 0;
  let weighted = 0;
  for (const d of days as ReadonlyArray<BuiltDay>) {
    totalKm += d.distanceKm;
    weighted += d.distanceKm * pick(d);
  }
  return totalKm > 0 ? weighted / totalKm : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Decide whether a route's surface mix meets the caller's allow-list.
 *
 * The rule is **majority by length, not presence**: at least 50% of the
 * sampled metres must be made up of allowed surfaces. A route that's
 * 40% asphalt and 60% gravel with filter `['asphalt']` is rejected,
 * because the allowed share is below the threshold even though some
 * allowed surface is present.
 *
 * Empty mixes (no road_segments hits along the day) are treated as
 * "unknown surfaces" and let through so an under-mapped corridor
 * doesn't block the only viable route.
 *
 * `mixMetres` values are road-segment lengths in **metres** (mirroring
 * the `road_segments.length_m` column). Only ratios are used, but the
 * parameter name preserves the metric contract for any future caller
 * that touches absolute totals.
 */
function isSurfaceMixMostlyAllowed(
  mixMetres: Record<string, number>,
  filter: AllowedSurface[],
): boolean {
  let allowedM = 0;
  let totalM = 0;
  for (const [k, v] of Object.entries(mixMetres)) {
    totalM += v;
    if ((filter as string[]).includes(k)) allowedM += v;
  }
  if (totalM === 0) return true;
  return allowedM / totalM >= 0.5;
}
