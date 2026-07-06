/**
 * Orchestrates writing the demo persona catalog into the database.
 *
 * Re-runnable by design: a full run first deletes every demo account
 * (which cascades to all of their rides/trips/hazards/etc. via the FK
 * rules) and the marker-tagged demo roads, then recreates everything.
 * Badges are awarded by delegating to the real `BadgesService` so they
 * match production rules instead of being hand-stamped.
 *
 * Geometry is written as plain GeoJSON objects on the entities; TypeORM's
 * PostGIS column type converts them on insert (the same path the hazards
 * and rides services use).
 */
import * as bcrypt from 'bcrypt';
import { DataSource, In, Like, Repository } from 'typeorm';
import {
  HAZARD_SEVERITY,
  HAZARD_TYPES,
  RIDE_TYPES,
  WAYPOINT_TYPES,
} from '@tarmoto/shared';
import { BadgesService } from '../../modules/badges/badges.service.js';
import { hashAdminPassword } from '../../modules/admin-auth/admin-password.js';
import { AdminUser } from '../../entities/admin-user.entity.js';
import { Bike } from '../../entities/bike.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { MountainPass } from '../../entities/mountain-pass.entity.js';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
import { TripFolder } from '../../entities/trip-folder.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripWaypoint } from '../../entities/trip-waypoint.entity.js';
import { User } from '../../entities/user.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import {
  DEMO_PERSONAS,
  DEMO_PREFERENCE_FLAG,
  demoPasswordFor,
  type DemoPersona,
} from './demo-personas.js';
import {
  DEMO_PASS_ROWS,
  DEMO_ROAD_LIKE,
  type LineString,
  buildDemoRoadSpecs,
  buildLineString,
  lineLengthKm,
  mulberry32,
  offsetLine,
  seedFromString,
  sliceLineByFraction,
} from './demo-data-builders.js';
import { REAL_DEMO_RIDES, REAL_DEMO_TRIPS } from './real-demo-rides.data.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Demo closures are keyed by a `demo:` external_id prefix so re-runs can
 * delete exactly our rows. The NAP reconcile pass only ever touches its
 * own `source = 'official'` rows, so operator-sourced demo rows with an
 * external_id are safe from it.
 */
const DEMO_CLOSURE_LIKE = 'demo:%';
// The most recent rides per persona are packed into the last few weeks so
// every demo account has both current-month and previous-month activity (the
// home "This month" KPI tiles + their "vs last month" deltas). The rest of a
// persona's history stays spread across its membership window.
const RECENT_RIDE_COUNT = 14;
const RECENT_RIDE_SPAN_DAYS = 28;
const BCRYPT_ROUNDS = 12;
const SAVE_CHUNK = 200;

/** Shared demo-road pool size — enough for the most-travelled persona. */
const ROAD_POOL_SIZE = Math.max(
  ...DEMO_PERSONAS.map((p) => p.roadsRiddenCount),
);

export interface SeedResult {
  usersCreated: number;
  roadsAvailable: number;
  ridesCreated: number;
  hazardsCreated: number;
  reviewsCreated: number;
  sharedRidesCreated: number;
  tripsCreated: number;
  followsCreated: number;
  badgesAwarded: number;
  passesEnsured: number;
  closuresCreated: number;
}

export interface CleanResult {
  usersDeleted: number;
  roadsDeleted: number;
}

export class DemoSeeder {
  constructor(
    private readonly ds: DataSource,
    private readonly badges: BadgesService,
  ) {}

  private repo<T extends object>(entity: { new (): T }): Repository<T> {
    return this.ds.getRepository(entity);
  }

  /** Delete demo accounts (cascades to their data) and demo roads. */
  async clean(
    emails: string[] = DEMO_PERSONAS.map((p) => p.email),
  ): Promise<CleanResult> {
    // Atomic so a re-run never half-cleans. Users go first: the FK cascade
    // clears their rides, ride_segments, road_reviews, trip_waypoints,
    // hazards, etc., leaving the demo roads unreferenced before we delete
    // them (road_segment_id FKs are RESTRICT, not CASCADE). If a *non-demo*
    // row still references a demo road, the road delete raises an FK error;
    // wrapping both deletes in one transaction rolls the user delete back
    // too, so the demo data stays intact and the seed can be retried after
    // the stray reference is resolved instead of being stuck half-removed.
    return this.ds.transaction(async (manager) => {
      // surface_readings FK ride_id / road_segment_id with no ON DELETE
      // (RESTRICT) and user_id as SET NULL — so they don't cascade with the
      // user, and while they exist they block deleting their ride (via the
      // user→rides cascade) and their demo road. Clear the demo personas'
      // readings first, by user_id (still set at this point), so the deletes
      // below aren't blocked.
      const demoUsers = await manager.find(User, {
        where: { email: In(emails) },
        select: ['id'],
      });
      if (demoUsers.length > 0) {
        await manager.delete(SurfaceReading, {
          user_id: In(demoUsers.map((u) => u.id)),
        });
      }
      const userResult = await manager.delete(User, { email: In(emails) });
      const roadResult = await manager.delete(RoadSegment, {
        road_number: Like(DEMO_ROAD_LIKE),
      });
      await manager.delete(RoadClosure, {
        external_id: Like(DEMO_CLOSURE_LIKE),
      });
      return {
        usersDeleted: userResult.affected ?? 0,
        roadsDeleted: roadResult.affected ?? 0,
      };
    });
  }

  async run(options: { only: string | null }): Promise<SeedResult> {
    const personas = this.resolvePersonas(options.only);
    const now = new Date();

    let roads: RoadSegment[];
    if (options.only) {
      // Refresh just this persona; leave shared roads (and other personas)
      // intact since their ride_segments reference the demo road pool.
      // Clear this persona's surface_readings first — they FK ride_id with
      // no ON DELETE, so they'd block the user→rides cascade below.
      const existing = await this.repo(User).find({
        where: { email: In([options.only]) },
        select: ['id'],
      });
      if (existing.length > 0) {
        await this.repo(SurfaceReading).delete({
          user_id: In(existing.map((u) => u.id)),
        });
      }
      await this.repo(User).delete({ email: In([options.only]) });
      roads = await this.ensureRoads();
    } else {
      await this.clean();
      roads = await this.createRoads();
    }

    const result: SeedResult = {
      usersCreated: 0,
      roadsAvailable: roads.length,
      ridesCreated: 0,
      hazardsCreated: 0,
      reviewsCreated: 0,
      sharedRidesCreated: 0,
      tripsCreated: 0,
      followsCreated: 0,
      badgesAwarded: 0,
      passesEnsured: 0,
      closuresCreated: 0,
    };

    for (const persona of personas) {
      const seeded = await this.seedPersona(persona, roads, now);
      result.usersCreated += 1;
      result.ridesCreated += seeded.rides;
      result.hazardsCreated += seeded.hazards;
      result.reviewsCreated += seeded.reviews;
      result.sharedRidesCreated += seeded.sharedRides;
      result.tripsCreated += seeded.trips;
      result.badgesAwarded += await this.awardBadges(seeded.userId);
    }

    result.followsCreated = await this.seedFollows(now);
    // CONDITIONS tab data: reference passes + demo closures carved from
    // the trips just seeded (skipped for --only refreshes, which leave
    // the other personas' trips — and therefore the closures — intact).
    result.passesEnsured = await this.ensurePasses();
    if (!options.only) {
      result.closuresCreated = await this.seedClosures(now);
    }

    // Upsert the admin super_admin account (idempotent — skips if already present).
    // Never seed a predictable backdoor account in production.
    if (process.env.NODE_ENV === 'production') {
      console.log('Skipping super_admin seed in production');
    } else {
      const adminRepo = this.repo(AdminUser);
      const adminEmail = 'admin@tarmoto.app';
      const existingAdmin = await adminRepo.findOne({
        where: { email: adminEmail },
      });
      if (!existingAdmin) {
        const seedPassword =
          process.env.TARMOTO_ADMIN_SEED_PASSWORD ?? adminEmail;
        await adminRepo.save(
          adminRepo.create({
            email: adminEmail,
            password_hash: await hashAdminPassword(seedPassword),
            role: 'super_admin',
            status: 'active',
          }),
        );
        console.log('Seeded super_admin:', adminEmail);
      }
    }

    return result;
  }

  private resolvePersonas(only: string | null): DemoPersona[] {
    if (!only) return DEMO_PERSONAS;
    const persona = DEMO_PERSONAS.find((p) => p.email === only);
    if (!persona) {
      const known = DEMO_PERSONAS.map((p) => p.email).join(', ');
      throw new Error(
        `Unknown demo persona "${only}". Known personas: ${known}.`,
      );
    }
    return [persona];
  }

  private async createRoads(): Promise<RoadSegment[]> {
    const repo = this.repo(RoadSegment);
    const rows = buildDemoRoadSpecs(ROAD_POOL_SIZE).map((spec) =>
      repo.create({
        geom: spec.geom,
        length_m: spec.length_m,
        road_name: spec.road_name,
        road_number: spec.road_number,
        curviness_score: spec.curviness_score,
        quality_score: spec.quality_score,
        surface_type: spec.surface_type,
        reading_count: spec.reading_count,
        confidence: spec.confidence,
      }),
    );
    return repo.save(rows, { chunk: SAVE_CHUNK });
  }

  /** Load the demo road pool, creating it if this DB has none yet. */
  private async ensureRoads(): Promise<RoadSegment[]> {
    const repo = this.repo(RoadSegment);
    const existing = await repo.find({
      where: { road_number: Like(DEMO_ROAD_LIKE) },
      order: { road_number: 'ASC' },
    });
    return existing.length > 0 ? existing : this.createRoads();
  }

  private async seedPersona(
    persona: DemoPersona,
    roads: RoadSegment[],
    now: Date,
  ): Promise<{
    userId: string;
    rides: number;
    hazards: number;
    reviews: number;
    sharedRides: number;
    trips: number;
  }> {
    const rng = mulberry32(seedFromString(persona.email));
    const joinedAt = new Date(now.getTime() - persona.joinedDaysAgo * DAY_MS);
    // Each demo account's password is its own email.
    const passwordHash = await bcrypt.hash(
      demoPasswordFor(persona),
      BCRYPT_ROUNDS,
    );

    const user = await this.repo(User).save(
      this.repo(User).create({
        email: persona.email,
        password_hash: passwordHash,
        display_name: persona.display_name,
        bio: persona.bio,
        home_region: persona.home_region,
        home_location: pointGeom(persona.home),
        subscription_tier: persona.subscription_tier,
        subscription_status:
          persona.subscription_tier === 'free' ? 'canceled' : 'active',
        subscription_current_period_end:
          persona.subscription_tier === 'free'
            ? null
            : new Date(now.getTime() + 30 * DAY_MS),
        email_verified_at: joinedAt,
        preferences: { [DEMO_PREFERENCE_FLAG]: true, units: 'metric' },
      }),
    );
    // `created_at` is a CreateDateColumn (always "now" on insert), so
    // backdate it explicitly to give the account a realistic join date.
    await this.repo(User).query(
      'UPDATE users SET created_at = $1 WHERE id = $2',
      [joinedAt, user.id],
    );

    const bikes = await this.repo(Bike).save(
      persona.bikes.map((b, i) =>
        this.repo(Bike).create({
          user_id: user.id,
          make: b.make,
          model: b.model,
          year: b.year,
          is_active: i === 0,
        }),
      ),
    );

    const rides = await this.seedRides(persona, user.id, bikes, rng, now);
    await this.seedRideSegments(persona, roads, rides, rng);
    await this.seedSurfaceReadings(persona, roads, rides, user.id, rng);
    await this.seedRideStats(persona, rides, rng);
    const hazards = await this.seedHazards(persona, user.id, roads, rng, now);
    const reviews = await this.seedReviews(persona, user.id, roads, rng, now);
    const sharedRides = await this.seedSharedRides(
      persona,
      user.id,
      rides,
      rng,
    );
    const trips = await this.seedTrips(persona, user.id, rng);

    return {
      userId: user.id,
      rides: rides.length,
      hazards,
      reviews,
      sharedRides,
      trips,
    };
  }

  private async seedRides(
    persona: DemoPersona,
    userId: string,
    bikes: Bike[],
    rng: () => number,
    now: Date,
  ): Promise<Ride[]> {
    if (persona.rideCount === 0) return [];
    if (persona.useRealGpx) {
      return this.seedRealRides(persona, userId, bikes, rng, now);
    }
    const repo = this.repo(Ride);
    const rows: Ride[] = [];
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    for (let i = 0; i < persona.rideCount; i++) {
      // First ride is the longest, to give `single_ride` something to bite.
      const distanceKm =
        i === 0
          ? round1(persona.baseRideKm * 2.2)
          : round1(persona.baseRideKm * (0.6 + rng() * 0.9));
      const avgSpeed = 45 + rng() * 30;
      const durationMs = (distanceKm / avgSpeed) * 60 * 60 * 1000;
      // Spread rides chronologically across the membership window — but pull
      // the most recent rides into the last ~4 weeks so every persona has
      // both current-month rides (the home "This month" KPI tiles need
      // `this_month_km > 0`) and previous-month rides (so the tiles' "vs last
      // month" deltas compute), regardless of which day of the month the
      // seed runs on.
      const recentRank = persona.rideCount - 1 - i; // 0 = newest
      let startedAt: Date;
      if (recentRank < RECENT_RIDE_COUNT) {
        const ageDays =
          (recentRank + rng()) * (RECENT_RIDE_SPAN_DAYS / RECENT_RIDE_COUNT);
        startedAt = new Date(now.getTime() - ageDays * DAY_MS);
        // Guarantee the single newest ride lands in the current calendar
        // month even on the 1st, so the tiles are never empty.
        if (recentRank === 0 && startedAt < startOfMonth) {
          startedAt = new Date(
            startOfMonth.getTime() +
              rng() * (now.getTime() - startOfMonth.getTime()),
          );
        }
      } else {
        const ageDays =
          (persona.joinedDaysAgo * (persona.rideCount - i)) /
            (persona.rideCount + 1) +
          rng();
        startedAt = new Date(now.getTime() - ageDays * DAY_MS);
      }
      const bike = bikes.length > 0 ? bikes[i % bikes.length] : undefined;
      rows.push(
        repo.create({
          user_id: userId,
          started_at: startedAt,
          ended_at: new Date(startedAt.getTime() + durationMs),
          distance_km: distanceKm,
          avg_speed: round1(avgSpeed),
          max_speed: round1(avgSpeed + 20 + rng() * 30),
          route_geom: buildLineString(rng, persona.home, 6),
          avg_road_quality: round1(2 + rng() * 3),
          avg_curviness: round2(rng()),
          ride_type: RIDE_TYPES[i % RIDE_TYPES.length] ?? RIDE_TYPES[0],
          name: i % 5 === 0 ? `${persona.home_region} loop #${i + 1}` : null,
          status: 'completed',
          bike_id: bike ? bike.id : null,
        }),
      );
    }
    return repo.save(rows, { chunk: SAVE_CHUNK });
  }

  /**
   * Seed a persona's rides from real recorded Calimoto GPX
   * (`REAL_DEMO_RIDES`) so the companion shows real routes instead of the
   * synthetic random walk. The recorded timestamps span ~2 years; they are
   * **rebased** so the newest ride ends ~yesterday relative to the seed run,
   * preserving each ride's real duration and the gaps between rides — so the
   * history always looks current (and the home "This month" KPI tiles have
   * data) no matter when the seed runs. Distance/duration/name/elevation are
   * the real values from the export; per-ride order matches `REAL_DEMO_RIDES`
   * so `seedRideStats` can line up the real elevation by index.
   */
  private async seedRealRides(
    persona: DemoPersona,
    userId: string,
    bikes: Bike[],
    rng: () => number,
    now: Date,
  ): Promise<Ride[]> {
    const repo = this.repo(Ride);
    // Shift the whole history so the most recent ride ends ~1 hour ago.
    const nowMs = now.getTime();
    const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const newest = REAL_DEMO_RIDES.reduce((a, b) =>
      Date.parse(b.endedAt) > Date.parse(a.endedAt) ? b : a,
    );
    const newestStartMs = Date.parse(newest.startedAt);
    let rebaseMs = nowMs - 60 * 60 * 1000 - Date.parse(newest.endedAt);
    // If the newest ride still lands in the *previous* calendar month (the seed
    // ran early on the 1st), pull it into the current month so the home "This
    // month" KPI tiles are populated — mirroring the synthetic path — while
    // keeping ended_at <= now whenever the ride fits in the month so far.
    if (newestStartMs + rebaseMs < startOfMonthMs) {
      const latestStartMs = nowMs - newest.durationSec * 1000;
      const targetStartMs =
        latestStartMs > startOfMonthMs
          ? startOfMonthMs + rng() * (latestStartMs - startOfMonthMs)
          : startOfMonthMs;
      rebaseMs += targetStartMs - (newestStartMs + rebaseMs);
    }
    const rows = REAL_DEMO_RIDES.map((r, i) => {
      const startedAt = new Date(Date.parse(r.startedAt) + rebaseMs);
      const endedAt = new Date(startedAt.getTime() + r.durationSec * 1000);
      const hours = r.durationSec / 3600;
      const avgSpeed = hours > 0 ? r.distanceKm / hours : 45;
      const bike = bikes.length > 0 ? bikes[i % bikes.length] : undefined;
      return repo.create({
        user_id: userId,
        started_at: startedAt,
        ended_at: endedAt,
        distance_km: round1(r.distanceKm),
        avg_speed: round1(avgSpeed),
        max_speed: round1(Math.min(160, avgSpeed * 1.5 + 10 + rng() * 15)),
        route_geom: lineGeom(r.points),
        avg_road_quality: round1(3 + rng() * 1.5),
        avg_curviness: round2(0.35 + rng() * 0.4),
        ride_type: r.rideType,
        name: r.name,
        status: 'completed',
        bike_id: bike ? bike.id : null,
      });
    });
    return repo.save(rows, { chunk: SAVE_CHUNK });
  }

  /**
   * Attach one ride_segment per "discovered" road so the persona's distinct
   * road count equals `roadsRiddenCount` (drives the exploration badge).
   */
  private async seedRideSegments(
    persona: DemoPersona,
    roads: RoadSegment[],
    rides: Ride[],
    rng: () => number,
  ): Promise<void> {
    if (rides.length === 0 || persona.roadsRiddenCount === 0) return;
    const repo = this.repo(RideSegment);
    const discovered = roads.slice(
      0,
      Math.min(persona.roadsRiddenCount, roads.length),
    );
    const seqByRide = new Map<string, number>();
    const rows = discovered.map((road, k) => {
      const ride = rides[k % rides.length];
      if (!ride) {
        throw new Error('Expected a ride for every ride_segment.');
      }
      const seq = (seqByRide.get(ride.id) ?? 0) + 1;
      seqByRide.set(ride.id, seq);
      return repo.create({
        ride_id: ride.id,
        road_segment_id: road.id,
        sequence: seq,
        speed_avg: round1(40 + rng() * 40),
        speed_max: round1(70 + rng() * 40),
        lean_angle_max: round1(15 + rng() * 35),
        quality_reading: round1(2 + rng() * 3),
        entered_at: ride.started_at,
        exited_at: ride.ended_at,
      });
    });
    await repo.save(rows, { chunk: SAVE_CHUNK });
  }

  /**
   * One `surface_reading` per "discovered" road, attributed to the persona —
   * what the sensor-upload pipeline persists for a rider with
   * `road_data_contribution` on. This is the source the "Your contribution"
   * sidebar badge (`/users/me/contribution`) counts: distinct road-quality
   * contributions, which is deliberately separate from `ride_segments`
   * (roads merely ridden). Without these rows every demo account reports
   * `km_mapped = 0` and the badge stays hidden, so the seed couldn't show it.
   * Attributing the same `discovered` roads gives each persona a real
   * km-mapped total, and `road.hunter` (most roads, Beskydy) tops its region.
   */
  private async seedSurfaceReadings(
    persona: DemoPersona,
    roads: RoadSegment[],
    rides: Ride[],
    userId: string,
    rng: () => number,
  ): Promise<void> {
    if (rides.length === 0 || persona.roadsRiddenCount === 0) return;
    const repo = this.repo(SurfaceReading);
    const contributed = roads.slice(
      0,
      Math.min(persona.roadsRiddenCount, roads.length),
    );
    const rows = contributed.map((road, k) => {
      const ride = rides[k % rides.length];
      if (!ride) {
        throw new Error('Expected a ride for every surface_reading.');
      }
      // IRI ~1–7 m/km, classified with the same bands as the sensor pipeline.
      const iri = round1(1 + rng() * 6);
      return repo.create({
        road_segment_id: road.id,
        ride_id: ride.id,
        user_id: userId,
        iri_value: iri,
        classification: classifyIri(iri),
        // Seeded rides always set `ended_at`; fall back for the nullable type.
        recorded_at: ride.ended_at ?? ride.started_at,
      });
    });
    await repo.save(rows, { chunk: SAVE_CHUNK });
  }

  /**
   * One `ride_stats` row per ride. The home "Lean angle" KPI tile and the
   * ride-detail screen read `ride_stats.max_lean_angle`; without these rows
   * the tile renders "—" even when the rider has current-month rides.
   */
  private async seedRideStats(
    persona: DemoPersona,
    rides: Ride[],
    rng: () => number,
  ): Promise<void> {
    if (rides.length === 0) return;
    const repo = this.repo(RideStats);
    const rows = rides.map((ride, i) => {
      // Real-GPX personas carry real elevation from the export (rides are in
      // `REAL_DEMO_RIDES` order); everyone else gets a plausible random value.
      const realElev = persona.useRealGpx ? REAL_DEMO_RIDES[i] : undefined;
      const maxLean = round1(28 + rng() * 22); // 28–50°
      const endedAt = ride.ended_at ?? ride.started_at;
      const durationSec = Math.max(
        0,
        Math.round((endedAt.getTime() - ride.started_at.getTime()) / 1000),
      );
      // Plausible per-ride lean histogram (1-second sensor windows) so the
      // ride-detail "Time spent leaning" chart has data. Roughly a third of
      // the ride is spent leaning, weighted toward the lower buckets.
      const leaning = Math.max(40, Math.round(durationSec / 3));
      const [w0, w1, w2, w3]: [number, number, number, number] = [
        0.3 + rng() * 0.2, // 0–10°
        0.3 + rng() * 0.15, // 10–20°
        0.15 + rng() * 0.15, // 20–30°
        0.05 + rng() * 0.15, // 30°+
      ];
      const wSum = w0 + w1 + w2 + w3;
      return repo.create({
        ride_id: ride.id,
        max_lean_angle: maxLean,
        avg_lean_angle: round1(maxLean * (0.45 + rng() * 0.2)),
        duration: `${durationSec} seconds`,
        elevation_gain: realElev
          ? realElev.elevationGain
          : round1(200 + rng() * 1200),
        elevation_loss: realElev
          ? realElev.elevationLoss
          : round1(200 + rng() * 1200),
        curve_count: Math.round(20 + rng() * 120),
        lean_distribution_json: {
          '0_10': Math.round((leaning * w0) / wSum),
          '10_20': Math.round((leaning * w1) / wSum),
          '20_30': Math.round((leaning * w2) / wSum),
          '30_plus': Math.round((leaning * w3) / wSum),
        },
      });
    });
    await repo.save(rows, { chunk: SAVE_CHUNK });
  }

  private async seedHazards(
    persona: DemoPersona,
    userId: string,
    roads: RoadSegment[],
    rng: () => number,
    now: Date,
  ): Promise<number> {
    if (persona.hazardCount === 0) return 0;
    const repo = this.repo(HazardReport);
    const rows: HazardReport[] = [];
    for (let i = 0; i < persona.hazardCount; i++) {
      const createdAt = new Date(
        now.getTime() - rng() * persona.joinedDaysAgo * DAY_MS,
      );
      const hazardRoad = roads.length > 0 ? roads[i % roads.length] : undefined;
      rows.push(
        repo.create({
          user_id: userId,
          road_segment_id: hazardRoad ? hazardRoad.id : null,
          location: pointGeom(jitter(persona.home, rng, 0.05)),
          hazard_type: HAZARD_TYPES[i % HAZARD_TYPES.length] ?? HAZARD_TYPES[0],
          severity:
            HAZARD_SEVERITY[i % HAZARD_SEVERITY.length] ?? HAZARD_SEVERITY[0],
          note: `Demo hazard #${i + 1} near ${persona.home_region}`,
          confirmations: Math.floor(rng() * 8),
          is_active: true,
          created_at: createdAt,
          expires_at: new Date(now.getTime() + (7 + (i % 21)) * DAY_MS),
        }),
      );
    }
    await repo.save(rows, { chunk: SAVE_CHUNK });
    return rows.length;
  }

  private async seedReviews(
    persona: DemoPersona,
    userId: string,
    roads: RoadSegment[],
    rng: () => number,
    now: Date,
  ): Promise<number> {
    // The (user, road) pair is unique, so each review needs a distinct road.
    const count = Math.min(persona.reviewCount, roads.length);
    if (count === 0) return 0;
    const repo = this.repo(RoadReview);
    const rows: RoadReview[] = [];
    for (let i = 0; i < count; i++) {
      const bike = persona.bikes[i % persona.bikes.length];
      const road = roads[i];
      if (!bike || !road) {
        throw new Error('Expected a bike and a road for every review.');
      }
      rows.push(
        repo.create({
          user_id: userId,
          road_segment_id: road.id,
          rating: 3 + Math.floor(rng() * 3),
          comment: `Demo review #${i + 1}: a genuinely fun stretch of road.`,
          bike_model: `${bike.make} ${bike.model}`,
          created_at: new Date(
            now.getTime() - rng() * persona.joinedDaysAgo * DAY_MS,
          ),
        }),
      );
    }
    await repo.save(rows, { chunk: SAVE_CHUNK });
    return rows.length;
  }

  private async seedSharedRides(
    persona: DemoPersona,
    userId: string,
    rides: Ride[],
    rng: () => number,
  ): Promise<number> {
    const count = Math.min(persona.sharedRideCount, rides.length);
    if (count === 0) return 0;
    const repo = this.repo(SharedRide);
    const rows = rides.slice(0, count).map((ride, i) =>
      repo.create({
        ride_id: ride.id,
        user_id: userId,
        share_token: token(`${userId}-${i}`, rng),
        is_public: true,
        view_count: Math.floor(rng() * 500),
        embed_click_count: Math.floor(rng() * 50),
      }),
    );
    await repo.save(rows, { chunk: SAVE_CHUNK });
    return rows.length;
  }

  private async seedTrips(
    persona: DemoPersona,
    userId: string,
    rng: () => number,
  ): Promise<number> {
    if (persona.tripCount === 0) return 0;
    if (persona.useRealGpx) {
      return this.seedRealTrips(userId, rng);
    }
    const tripRepo = this.repo(Trip);
    const dayRepo = this.repo(TripDay);
    const wpRepo = this.repo(TripWaypoint);
    const memberRepo = this.repo(TripMember);
    const folderRepo = this.repo(TripFolder);

    // Folders for the US-37 flow: even-indexed trips are filed (round-robin
    // across folders), odd-indexed ones stay unfiled so the "Unfiled"
    // pseudo-bucket is exercised too.
    const folders = await folderRepo.save(
      (
        [
          { name: 'Favourites', color: '#2563eb' },
          { name: 'Bucket list', color: '#16a34a' },
        ] as const
      ).map(({ name, color }, i) =>
        folderRepo.create({
          user_id: userId,
          name,
          color,
          position: i,
        }),
      ),
    );

    for (let t = 0; t < persona.tripCount; t++) {
      const numDays = 2 + Math.floor(rng() * 4);
      const folder =
        t % 2 === 0 ? folders[Math.floor(t / 2) % folders.length] : undefined;
      const folderId = folder ? folder.id : null;
      const trip = await tripRepo.save(
        tripRepo.create({
          owner_id: userId,
          folder_id: folderId,
          title: `${persona.home_region} ${numDays}-day tour #${t + 1}`,
          region: persona.home_region,
          num_days: numDays,
          daily_km_min: 150,
          daily_km_max: 350,
          min_quality: 3,
          road_preference: 'curvy',
          status: t === 0 ? 'active' : 'planned',
          invite_code: token(`${userId}-trip-${t}`, rng).slice(0, 12),
        }),
      );
      await memberRepo.save(
        memberRepo.create({
          trip_id: trip.id,
          user_id: userId,
          role: 'owner',
        }),
      );
      for (let d = 0; d < numDays; d++) {
        const route = buildLineString(rng, jitter(persona.home, rng, 0.3), 8);
        const day = await dayRepo.save(
          dayRepo.create({
            trip_id: trip.id,
            day_number: d + 1,
            title: `Day ${d + 1}`,
            distance_km: round1(lineLengthKm(route)),
            route_geom: route,
            avg_quality: round1(3 + rng() * 2),
            curviness_score: round2(rng()),
            scenic_score: round2(rng()),
          }),
        );
        const stops = route.coordinates.slice(0, 4);
        await wpRepo.save(
          stops.map((coord, w) =>
            wpRepo.create({
              trip_day_id: day.id,
              sequence: w,
              location: coordPoint(coord),
              name: waypointName(w, stops.length),
              waypoint_type: waypointType(w, stops.length),
            }),
          ),
        );
      }
    }
    return persona.tripCount;
  }

  /**
   * Re-insert any canonical mountain pass that's missing. The migration
   * seeded these once, but dev databases rebuilt from dumps often carry
   * the migration marker without the rows — CONDITIONS then has nothing
   * to show. Insert-if-missing keeps operator edits (override_status,
   * notes) on existing rows untouched.
   */
  private async ensurePasses(): Promise<number> {
    const repo = this.repo(MountainPass);
    const existing = new Set(
      (await repo.find({ select: ['name'] })).map((p) => p.name),
    );
    const missing = DEMO_PASS_ROWS.filter((row) => !existing.has(row.name));
    if (missing.length === 0) return 0;
    await repo.save(
      missing.map((row) =>
        repo.create({
          name: row.name,
          country_code: row.country_code,
          region: row.region,
          location: {
            type: 'Point',
            coordinates: [row.lng, row.lat],
          },
          elevation_m: row.elevation_m,
          typical_open_month: row.typical_open_month,
          typical_close_month: row.typical_close_month,
          notes: row.notes,
        }),
      ),
    );
    return missing.length;
  }

  /**
   * Fabricate closures & roadworks that provably intersect demo content:
   * the geometry is CARVED OUT of seeded trip-day routes, so the
   * planner's 100 m check-route corridor hits them when a demo trip is
   * opened. Two fixed real-world rows (road 44 over Červenohorské sedlo,
   * D1 roadworks near Velké Meziříčí) round out the map layer for
   * ad-hoc routes.
   */
  private async seedClosures(now: Date): Promise<number> {
    const repo = this.repo(RoadClosure);
    await repo.delete({ external_id: Like(DEMO_CLOSURE_LIKE) });

    // One donor day per distinct demo trip, favouring the personas'
    // active tours (trip #1 of each) so opening any demo profile's
    // current trip shows conditions.
    const donorDays = await repo.manager
      .createQueryBuilder(TripDay, 'day')
      .innerJoin(Trip, 'trip', 'trip.id = day.trip_id')
      .innerJoin(User, 'owner', 'owner.id = trip.owner_id')
      .where('owner.email IN (:...emails)', {
        emails: DEMO_PERSONAS.map((p) => p.email),
      })
      .andWhere('day.route_geom IS NOT NULL')
      .andWhere('day.day_number = 1')
      .orderBy('trip.title', 'ASC')
      // `.limit`, not `.take`: take() wraps the query in a DISTINCT
      // subselect that can't see the joined trip.title ordering column.
      .limit(5)
      .getMany();

    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const daysAhead = (days: number) => new Date(now.getTime() + days * DAY_MS);

    const closures: Partial<RoadClosure>[] = [];
    const templates: Array<
      (line: GeoJSON.LineString, index: number) => Partial<RoadClosure>
    > = [
      (line, index) => ({
        external_id: `demo:trip-roadworks-${index}`,
        title: 'Resurfacing works — alternating traffic',
        reason: 'roadworks',
        severity: 'partial',
        geom: sliceLineByFraction(line, 0.35, 0.55),
        detour_geom: offsetLine(
          sliceLineByFraction(line, 0.35, 0.55),
          0.012,
          -0.008,
        ),
        starts_at: daysAgo(10),
        ends_at: daysAhead(45),
        notes: 'Temporary signals; expect 10–15 min delay at peak times.',
      }),
      (line, index) => ({
        external_id: `demo:trip-closure-${index}`,
        title: 'Bridge closed after structural inspection',
        reason: 'closure',
        severity: 'full',
        geom: sliceLineByFraction(line, 0.6, 0.75),
        starts_at: daysAgo(21),
        ends_at: null,
        notes: 'Closed until further notice; no signed motorcycle detour.',
      }),
      (line, index) => ({
        external_id: `demo:trip-seasonal-${index}`,
        title: 'Seasonal closure — forest road section',
        reason: 'seasonal',
        severity: 'full',
        geom: sliceLineByFraction(line, 0.2, 0.35),
        starts_at: daysAgo(30),
        ends_at: daysAhead(30),
        notes: 'Annual closure window for logging traffic.',
      }),
      (line, index) => ({
        external_id: `demo:trip-weather-${index}`,
        title: 'Surface flooding after storms',
        reason: 'weather',
        severity: 'advisory',
        geom: sliceLineByFraction(line, 0.45, 0.6),
        starts_at: daysAgo(1),
        ends_at: daysAhead(3),
        notes: 'Standing water in dips; passable with care.',
      }),
      (line, index) => ({
        external_id: `demo:trip-event-${index}`,
        title: 'Road race — rolling closures',
        reason: 'event',
        severity: 'full',
        geom: sliceLineByFraction(line, 0.1, 0.25),
        starts_at: daysAgo(1),
        ends_at: daysAhead(10),
        notes: 'Course marshals on site; through traffic held in waves.',
      }),
    ];
    donorDays.forEach((day, index) => {
      const template = templates[index % templates.length]!;
      closures.push(template(day.route_geom as GeoJSON.LineString, index + 1));
    });

    // Fixed real-world rows for ad-hoc planner routes + the map layer.
    closures.push(
      {
        external_id: 'demo:cz-44-cervenohorske',
        title: 'Road 44 — Červenohorské sedlo maintenance closure',
        reason: 'seasonal',
        severity: 'full',
        geom: {
          type: 'LineString',
          coordinates: [
            [17.1105, 50.1032],
            [17.1242, 50.1125],
            [17.1381, 50.1198],
          ],
        },
        starts_at: daysAgo(14),
        ends_at: daysAhead(21),
        notes: 'Pass road closed for guardrail renewal; detour via Ramzová.',
      },
      {
        external_id: 'demo:cz-d1-velke-mezirici',
        title: 'D1 modernisation — lane restrictions near Velké Meziříčí',
        reason: 'roadworks',
        severity: 'partial',
        geom: {
          type: 'LineString',
          coordinates: [
            [15.9605, 49.3402],
            [16.0122, 49.3553],
            [16.0655, 49.3688],
          ],
        },
        detour_geom: {
          type: 'LineString',
          coordinates: [
            [15.9605, 49.3402],
            [16.0135, 49.3462],
            [16.0655, 49.3688],
          ],
        },
        starts_at: daysAgo(40),
        ends_at: daysAhead(90),
        notes: 'Two narrowed lanes, 80 km/h; congestion on summer weekends.',
      },
    );

    await repo.save(
      closures.map((spec) =>
        repo.create({
          ...spec,
          country_code: 'CZ',
          region: null,
          source: 'operator',
          created_by: null,
          is_active: true,
        }),
      ),
    );
    return closures.length;
  }

  /**
   * Seed a persona's trips from real planned Calimoto routes
   * (`REAL_DEMO_TRIPS`): the multi-day "Den 1→2→3" trip becomes one
   * `num_days`=3 trip and the single-day plans become 1-day trips, each with
   * real route geometry and waypoints. Mirrors {@link seedTrips} (folders,
   * owner membership, per-day + waypoint rows) but takes geometry from the
   * export instead of a random walk.
   */
  private async seedRealTrips(
    userId: string,
    rng: () => number,
  ): Promise<number> {
    const tripRepo = this.repo(Trip);
    const dayRepo = this.repo(TripDay);
    const wpRepo = this.repo(TripWaypoint);
    const memberRepo = this.repo(TripMember);
    const folderRepo = this.repo(TripFolder);

    const folders = await folderRepo.save(
      (
        [
          { name: 'Favourites', color: '#2563eb' },
          { name: 'Bucket list', color: '#16a34a' },
        ] as const
      ).map(({ name, color }, i) =>
        folderRepo.create({ user_id: userId, name, color, position: i }),
      ),
    );

    for (let t = 0; t < REAL_DEMO_TRIPS.length; t++) {
      const src = REAL_DEMO_TRIPS[t];
      if (!src) continue;
      const folder =
        t % 2 === 0 ? folders[Math.floor(t / 2) % folders.length] : undefined;
      const trip = await tripRepo.save(
        tripRepo.create({
          owner_id: userId,
          folder_id: folder ? folder.id : null,
          title: src.title,
          region: src.region,
          num_days: src.days.length,
          daily_km_min: 150,
          daily_km_max: 350,
          min_quality: 3,
          road_preference: 'curvy',
          status: t === 0 ? 'active' : 'planned',
          invite_code: token(`${userId}-trip-${t}`, rng).slice(0, 12),
        }),
      );
      await memberRepo.save(
        memberRepo.create({ trip_id: trip.id, user_id: userId, role: 'owner' }),
      );
      for (const srcDay of src.days) {
        const day = await dayRepo.save(
          dayRepo.create({
            trip_id: trip.id,
            day_number: srcDay.dayNumber,
            title: srcDay.title,
            distance_km: round1(srcDay.distanceKm),
            route_geom: lineGeom(srcDay.points),
            avg_quality: round1(3 + rng() * 2),
            curviness_score: round2(0.4 + rng() * 0.4),
            scenic_score: round2(0.4 + rng() * 0.4),
          }),
        );
        const stops = srcDay.waypoints;
        await wpRepo.save(
          stops.map((wp, w) =>
            wpRepo.create({
              trip_day_id: day.id,
              sequence: w,
              location: coordPoint([wp.lng, wp.lat]),
              name: waypointName(w, stops.length),
              waypoint_type: waypointType(w, stops.length),
            }),
          ),
        );
      }
    }
    return REAL_DEMO_TRIPS.length;
  }

  private async awardBadges(userId: string): Promise<number> {
    const { newly_earned } = await this.badges.checkAndAward(userId);
    return newly_earned.length;
  }

  /**
   * Rebuild the full demo follow graph from whatever demo accounts are
   * currently in the database — NOT just the ones reseeded this run. A
   * `--only` reseed deletes the selected user, which cascade-removes every
   * follow edge touching it (both directions); reading the live id map and
   * replaying the whole catalog restores that account's outgoing follows
   * AND the incoming follows from other demo users. `orIgnore` makes the
   * edges already present on a full re-run no-ops.
   */
  private async seedFollows(now: Date): Promise<number> {
    const existing = await this.repo(User).find({
      where: { email: In(DEMO_PERSONAS.map((p) => p.email)) },
      select: { id: true, email: true },
    });
    const emailToId = new Map(existing.map((u) => [u.email, u.id]));

    const repo = this.repo(UserFollow);
    const rows: {
      follower_id: string;
      following_id: string;
      created_at: Date;
    }[] = [];
    const seen = new Set<string>();
    for (const persona of DEMO_PERSONAS) {
      const followerId = emailToId.get(persona.email);
      if (!followerId) continue;
      for (const target of persona.follows) {
        const followingId = emailToId.get(target);
        // Target account isn't in this database — skip the dangling edge.
        if (!followingId) continue;
        const key = `${followerId}:${followingId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          follower_id: followerId,
          following_id: followingId,
          created_at: now,
        });
      }
    }
    if (rows.length === 0) return 0;
    await repo.createQueryBuilder().insert().values(rows).orIgnore().execute();
    return rows.length;
  }
}

interface PointGeom {
  type: 'Point';
  coordinates: [number, number];
}

function pointGeom(p: { lat: number; lng: number }): PointGeom {
  return { type: 'Point', coordinates: [p.lng, p.lat] };
}

function coordPoint(coord: [number, number]): PointGeom {
  return { type: 'Point', coordinates: coord };
}

/** GeoJSON LineString from concrete `[lng, lat]` pairs (real GPX geometry). */
function lineGeom(coordinates: [number, number][]): LineString {
  return { type: 'LineString', coordinates };
}

function jitter(
  p: { lat: number; lng: number },
  rng: () => number,
  span: number,
): { lat: number; lng: number } {
  return {
    lat: p.lat + (rng() - 0.5) * span,
    lng: p.lng + (rng() - 0.5) * span,
  };
}

/** A 32-char share/invite token: deterministic, collision-resistant enough. */
function token(seed: string, rng: () => number): string {
  const noise = Math.floor(rng() * 0xffffffff).toString(36);
  return `${seedFromString(seed).toString(36)}${noise}`
    .padEnd(32, '0')
    .slice(0, 32);
}

function waypointType(index: number, total: number): string {
  if (index === 0) return 'start';
  if (index === total - 1) return 'end';
  const mid = ['via', 'fuel', 'coffee', 'photo'].filter((t) =>
    (WAYPOINT_TYPES as readonly string[]).includes(t),
  );
  return mid[index % mid.length] ?? 'via';
}

function waypointName(index: number, total: number): string {
  if (index === 0) return 'Start';
  if (index === total - 1) return 'Finish';
  return `Stop ${index}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * IRI (m/km) → quality class, mirroring the sensor service's `classify`
 * bands so seeded surface_readings carry plausible classifications.
 */
function classifyIri(iri: number): string {
  if (iri < 1.5) return 'excellent';
  if (iri < 3.0) return 'good';
  if (iri < 5.5) return 'fair';
  if (iri < 9.0) return 'poor';
  return 'very_poor';
}
