import {
  BadRequestException,
  ForbiddenException,
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
  type RoutingOptions,
} from '../commute/routing-provider.interface.js';
import { EventsGateway } from '../events/events.gateway.js';
import { TripActivityService } from '../trip-activity/trip-activity.service.js';
import { ClosuresService } from '../closures/closures.service.js';
import { TripsService } from './trips.service.js';
import { GenerateTripResponseDto } from './dto/generate-trip-response.dto.js';
import {
  GenerateTripDto,
  type AllowedSurface,
  type TripGenerationOptionId,
} from './dto/generate-trip.dto.js';
import {
  TripDayDto,
  TripWaypointDto,
  type TripWaypointType,
} from './dto/trip-response.dto.js';
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
import {
  RouteEnrichmentService,
  type RouteMetrics,
} from '../routing/route-enrichment.service.js';

/**
 * One scored candidate for a given day. The same `Candidate[]` is used
 * across all three option scorers — `scoreRoute` differentiates by
 * applying the preset's weights.
 */
interface Candidate {
  alt: RouteAlternative;
  metrics: RouteMetrics;
  /**
   * 1-day roundtrips only: index in `alt.geometry` where the outbound
   * leg turns back toward the start. Persisted as a `via` waypoint so a
   * later waypoint-based re-route keeps the loop shape instead of
   * collapsing start→end (same point) to a 0 km leg.
   */
  viaIndex?: number;
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
    private readonly enrichment: RouteEnrichmentService,
    private readonly closuresService: ClosuresService,
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
    signal?: AbortSignal,
  ): Promise<GenerateTripResponseDto> {
    const startedAt = Date.now();
    // Folds "no such trip" and "you're not a member" into one 404 so
    // the endpoint can't be used to enumerate trip ids.
    const membership = await this.memberRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!membership) throw new NotFoundException('Trip not found');
    // Viewers are read-and-comment only — regenerating the itinerary is
    // a route write.
    if (membership.role === 'viewer') {
      throw new ForbiddenException(
        'Editing the route needs editor access — ask the trip owner to upgrade your role',
      );
    }

    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    // Regenerating a completed trip flips it back to `planned`
    // (`persistSelected`), a net-new open trip against the owner's cap.
    // Gate it before the expensive routing work so an over-cap owner
    // fails fast, mirroring the reopen/import promotion checks. Owner's
    // cap governs, not the (possibly collaborator) caller's.
    if (trip.status === 'completed') {
      await this.tripsService.assertCanMintOpenTrip(trip.owner_id);
    }

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
    // Per-request routing avoidance — passed through to the
    // `RoutingProvider` so OSRM can drop motorway / toll edges from the
    // alternatives. Honour depends on the upstream profile (the public
    // OSRM demo honours `motorway`; toll exclusion needs a custom
    // build), but we always plumb the flags so a self-hosted backend
    // gets the rider's intent.
    // Route every day's legs around active full closures in the trip area
    // (#744). Fetched once for the whole trip bbox and reused across days.
    const exclusionRoute = [
      chain[0]?.from ?? start,
      ...chain.map((leg) => leg.to),
    ];
    const excludePolygons = await this.closuresService.exclusionPolygons(
      {
        minLng: bbox[0],
        minLat: bbox[1],
        maxLng: bbox[2],
        maxLat: bbox[3],
      },
      exclusionRoute,
    );
    const routingOptions: RoutingOptions = {
      avoidHighways: dto.avoid_highways,
      avoidTolls: dto.avoid_tolls,
      excludePolygons,
      // Score the primary route too, not just the alternatives — many
      // rural / mountain legs have a single OSRM-returned route and
      // dropping the primary would otherwise leave us with an empty
      // candidate set and a synthetic 0 km fallback day.
      includePrimary: true,
    };
    const routingStartedAt = Date.now();
    let candidatesByDay: Candidate[][];
    if (numDays === 1) {
      // Single-day trips are ROUNDTRIPS: out to the day's anchor and back
      // to the start (the multi-day chain closes its loop on the final
      // day; the 1-day chain previously emitted only the outbound leg,
      // stranding the rider at the anchor). Each outbound alternative is
      // paired with the primary return route; the merged candidate is
      // scored as one loop.
      const leg = chain[0];
      if (!leg) throw new Error('generate: empty day chain');
      const [outCandidates, backCandidates] = await Promise.all([
        this.candidatesForLeg(
          leg.from,
          leg.to,
          surfaceFilter,
          trip.min_quality,
          routingOptions,
          signal,
        ),
        this.candidatesForLeg(
          leg.to,
          leg.from,
          surfaceFilter,
          trip.min_quality,
          routingOptions,
          signal,
        ),
      ]);
      const out =
        outCandidates.length > 0
          ? outCandidates
          : [this.fallbackCandidate(leg.from, leg.to)];
      const back =
        backCandidates[0] ?? this.fallbackCandidate(leg.to, leg.from);
      candidatesByDay = [
        out.map((candidate) => mergeRoundtripCandidate(candidate, back)),
      ];
    } else {
      candidatesByDay = await Promise.all(
        chain.map(async (leg) => {
          const candidates = await this.candidatesForLeg(
            leg.from,
            leg.to,
            surfaceFilter,
            trip.min_quality,
            routingOptions,
            signal,
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
    }

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
    const routingMs = Date.now() - routingStartedAt;
    // `OPTION_PRESETS` is derived from a `Record<TripGenerationOptionId, …>`
    // so every option id has a preset by construction; the find here is a
    // total lookup, no defensive 404 needed.
    const selected = builtOptions.find((o) => o.preset.id === selectedId)!;

    signal?.throwIfAborted();
    const persistenceStartedAt = Date.now();
    await this.persistSelected(tripId, selected);
    const persistenceMs = Date.now() - persistenceStartedAt;

    const detailStartedAt = Date.now();
    const detail = await this.tripsService.getDetail(userId, tripId);
    const detailMs = Date.now() - detailStartedAt;
    // Emit both events: `trip:updated` carries the full refreshed
    // detail so any collaborator already listening on the socket room
    // (the same channel `TripsService.update` writes to) refreshes
    // their cached view — `persistSelected` flipped `status` from
    // `draft` to `planned` and rewrote every day, so the previous
    // `getDetail` cache is stale. `trip:generated` is the
    // generation-specific signal carrying the selected preset id so
    // the companion's "compare side-by-side" view can react without
    // re-deriving from the detail payload.
    this.events.emitToTrip(tripId, 'trip:updated', detail);
    this.events.emitToTrip(tripId, 'trip:generated', {
      tripId,
      selected_option: selectedId,
    });
    await this.activity.recordSafe(tripId, userId, 'trip_generated', {
      option: selectedId,
      num_days: numDays,
    });

    const totalMs = Date.now() - startedAt;
    if (totalMs >= 1_000) {
      this.logger.warn(
        `Planner generation took ${totalMs}ms ` +
          `(routing=${routingMs}ms, persistence=${persistenceMs}ms, ` +
          `detail=${detailMs}ms, ` +
          `days=${numDays})`,
      );
    }

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
    routingOptions: RoutingOptions,
    signal?: AbortSignal,
  ): Promise<Candidate[]> {
    let alts: RouteAlternative[];
    try {
      alts = signal
        ? await this.routingProvider.getAlternatives(
            from.lat,
            from.lng,
            to.lat,
            to.lng,
            3,
            routingOptions,
            signal,
          )
        : await this.routingProvider.getAlternatives(
            from.lat,
            from.lng,
            to.lat,
            to.lng,
            3,
            routingOptions,
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

    // Enrich every alternative in parallel — each aggregate call runs three
    // PostGIS queries concurrently, but the
    // alternatives themselves used to be awaited sequentially, which
    // multiplied the per-day latency by `alts.length`. The endpoint's
    // <10s budget can't afford that on a multi-day trip with 3 alts
    // per day. Cache the result by route reference so the fallback
    // path below can reuse it.
    const enrichable = alts.filter((alt) => alt.geometry.length >= 2);
    const enrichedList = await Promise.all(
      enrichable.map((alt) =>
        signal
          ? this.enrichment.aggregate(alt.geometry, signal)
          : this.enrichment.aggregate(alt.geometry),
      ),
    );
    const enriched = new Map<RouteAlternative, RouteMetrics>();
    enrichable.forEach((alt, i) => {
      const metrics = enrichedList[i];
      if (metrics) enriched.set(alt, metrics);
    });

    const candidates: Candidate[] = [];
    for (const alt of enrichable) {
      const metrics = enriched.get(alt);
      if (!metrics) continue;
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
    const primary = alts[0];
    if (candidates.length === 0 && primary && primary.geometry.length >= 2) {
      // Both filters dropped every candidate. Keep the primary as a
      // last-resort so the day still has something to render — the
      // option summary numbers will reflect the lower quality and the
      // UI can warn the rider. Reuse the metrics we already computed
      // for `alts[0]` in the loop above; falling back to a fresh
      // `aggregateRouteMetrics` call would waste 4 PostGIS round-trips
      // per fallback day.
      const cached = enriched.get(primary);
      const metrics =
        cached ??
        (signal
          ? await this.enrichment.aggregate(primary.geometry, signal)
          : await this.enrichment.aggregate(primary.geometry));
      candidates.push({ alt: primary, metrics });
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
      const first = candidates[0];
      if (!first) {
        throw new Error(
          `buildOption: day ${dayIdx + 1} has no route candidates`,
        );
      }
      let best = first;
      let bestScore = scoreRoute(preset, {
        avgQuality: best.metrics.avgQuality,
        curvinessScore: best.metrics.curvinessScore,
        scenicScore: best.metrics.scenicScore,
        durationMin: best.alt.duration_min,
        distanceKm: best.alt.distance_km,
        targetKm,
        hazardCount: best.metrics.hazardCount,
      });
      for (let i = 1; i < candidates.length; i++) {
        const cand = candidates[i];
        if (!cand) continue;
        const score = scoreRoute(preset, {
          avgQuality: cand.metrics.avgQuality,
          curvinessScore: cand.metrics.curvinessScore,
          scenicScore: cand.metrics.scenicScore,
          durationMin: cand.alt.duration_min,
          distanceKm: cand.alt.distance_km,
          targetKm,
          hazardCount: cand.metrics.hazardCount,
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

  /**
   * A generated successor day's start sits at the previous day's overnight
   * terminal (its `hotel`, or `end` on the final day). Day N≥2 is therefore
   * linked when its start coordinates match the previous day's terminal — the
   * companion uses `start_linked` to mirror the boundary and suppress the
   * duplicate marker drawn on top of the overnight stop. Day 1 is never linked.
   */
  private isDayStartLinked(days: BuiltDay[], i: number): boolean {
    if (i < 1) return false;
    const day = days[i];
    const prevDay = days[i - 1];
    if (!day || !prevDay) return false;
    const start = day.waypoints.find((w) => w.waypoint_type === 'start');
    const prevTerminal = prevDay.waypoints.find(
      (w) => w.waypoint_type === 'hotel' || w.waypoint_type === 'end',
    );
    return (
      !!start &&
      !!prevTerminal &&
      start.lat === prevTerminal.lat &&
      start.lng === prevTerminal.lng
    );
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
    if (!startPt || !endPt) {
      throw new Error(`buildDay: day ${dayNumber} route geometry is empty`);
    }

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
    const midStops: Array<{ idx: number; type: 'fuel' | 'via' }> =
      fuelIndices.map((idx) => ({ idx, type: 'fuel' as const }));
    if (
      cand.viaIndex !== undefined &&
      cand.viaIndex > 0 &&
      cand.viaIndex < route.length - 1
    ) {
      midStops.push({ idx: cand.viaIndex, type: 'via' });
    }
    midStops.sort((a, b) => a.idx - b.idx);
    for (const stop of midStops) {
      const p = route[stop.idx];
      if (!p) continue;
      waypoints.push({
        sequence: seq++,
        lat: p.lat,
        lng: p.lng,
        name: stop.type === 'via' ? 'Turnaround' : 'Fuel stop',
        waypoint_type: stop.type,
        duration_min: stop.type === 'fuel' ? 15 : null,
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
    //
    // Save shape: 3 round-trips total instead of `1 + numDays + Σ
    // waypoints` — bulk-insert all days first, capture their generated
    // ids, then bulk-insert every waypoint with the right `trip_day_id`
    // in one final call. A 14-day trip with ~4 waypoints/day previously
    // issued ~70 sequential INSERTs inside the txn.
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(TripDay, { trip_id: tripId });

      const dayRows = option.days.map((day, dayIdx) =>
        manager.create(TripDay, {
          trip_id: tripId,
          day_number: day.dayNumber,
          title: day.title,
          start_linked: this.isDayStartLinked(option.days, dayIdx),
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
        }),
      );
      const savedDays = await manager.save(dayRows);

      const waypointRows = option.days.flatMap((day, dayIdx) => {
        const savedDay = savedDays[dayIdx];
        if (!savedDay) {
          throw new Error(
            `persistOption: missing saved day for index ${dayIdx}`,
          );
        }
        return day.waypoints.map((w) =>
          manager.create(TripWaypoint, {
            trip_day_id: savedDay.id,
            sequence: w.sequence,
            location: latLngToPoint({ lat: w.lat, lng: w.lng }),
            name: w.name,
            waypoint_type: w.waypoint_type,
            duration_min: w.duration_min,
            notes: w.notes,
          }),
        );
      });
      if (waypointRows.length > 0) {
        await manager.save(waypointRows);
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
      days: option.days.map((d, dayIdx): TripDayDto => ({
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
        start_linked: this.isDayStartLinked(option.days, dayIdx),
        route_geometry: d.geometry,
        waypoints: d.waypoints.map((w): TripWaypointDto => ({
          id: '',
          sequence: w.sequence,
          lat: w.lat,
          lng: w.lng,
          name: w.name,
          waypoint_type: w.waypoint_type as TripWaypointType,
          road_segment_id: null,
          notes: w.notes,
          duration_min: w.duration_min,
        })),
      })),
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

/**
 * Merge an outbound candidate with the shared return route into one
 * loop candidate: geometry concatenated (deduping the shared anchor
 * vertex), distances/durations/elevation/hazards summed, quality-style
 * metrics distance-weighted, and the turnaround recorded as `viaIndex`.
 */
function mergeRoundtripCandidate(out: Candidate, back: Candidate): Candidate {
  const outKm = out.alt.distance_km;
  const backKm = back.alt.distance_km;
  const totalKm = outKm + backKm || 1;
  // A leg without a metric must not count as zero over the full loop
  // distance — that would penalize loops through under-mapped areas.
  // Average only over the leg(s) that actually have the metric.
  const weighted = (a: number | null, b: number | null): number | null => {
    if (a === null) return b;
    if (b === null) return a;
    return (a * outKm + b * backKm) / totalKm;
  };
  const surfaceMixMetres: Record<string, number> = {
    ...out.metrics.surfaceMixMetres,
  };
  for (const [surface, metres] of Object.entries(
    back.metrics.surfaceMixMetres,
  )) {
    surfaceMixMetres[surface] = (surfaceMixMetres[surface] ?? 0) + metres;
  }
  return {
    alt: {
      distance_km: outKm + backKm,
      duration_min: out.alt.duration_min + back.alt.duration_min,
      geometry: [...out.alt.geometry, ...back.alt.geometry.slice(1)],
    },
    metrics: {
      avgQuality: weighted(out.metrics.avgQuality, back.metrics.avgQuality),
      curvinessScore: weighted(
        out.metrics.curvinessScore,
        back.metrics.curvinessScore,
      ),
      scenicScore: weighted(out.metrics.scenicScore, back.metrics.scenicScore),
      elevationGain: out.metrics.elevationGain + back.metrics.elevationGain,
      elevationLoss: out.metrics.elevationLoss + back.metrics.elevationLoss,
      hazardCount: out.metrics.hazardCount + back.metrics.hazardCount,
      surfaceMixMetres,
    },
    viaIndex: out.alt.geometry.length - 1,
  };
}
