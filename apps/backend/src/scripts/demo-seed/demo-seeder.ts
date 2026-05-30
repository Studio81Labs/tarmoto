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
import { Bike } from '../../entities/bike.entity.js';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripDay } from '../../entities/trip-day.entity.js';
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
  DEMO_ROAD_MARKER,
  buildDemoRoadSpecs,
  buildLineString,
  lineLengthKm,
  mulberry32,
  seedFromString,
} from './demo-data-builders.js';

const DAY_MS = 24 * 60 * 60 * 1000;
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
    // Users first: the FK cascade clears their rides, ride_segments,
    // road_reviews, trip_waypoints, hazards, etc. so the demo roads are
    // unreferenced by the time we delete them (road_segment_id FKs are
    // RESTRICT, not CASCADE).
    const userResult = await this.repo(User).delete({ email: In(emails) });
    const roadResult = await this.repo(RoadSegment).delete({
      road_number: Like(`${DEMO_ROAD_MARKER}%`),
    });
    return {
      usersDeleted: userResult.affected ?? 0,
      roadsDeleted: roadResult.affected ?? 0,
    };
  }

  async run(options: { only: string | null }): Promise<SeedResult> {
    const personas = this.resolvePersonas(options.only);
    const now = new Date();

    let roads: RoadSegment[];
    if (options.only) {
      // Refresh just this persona; leave shared roads (and other personas)
      // intact since their ride_segments reference the demo road pool.
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
      where: { road_number: Like(`${DEMO_ROAD_MARKER}%`) },
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
    const repo = this.repo(Ride);
    const rows: Ride[] = [];
    for (let i = 0; i < persona.rideCount; i++) {
      // First ride is the longest, to give `single_ride` something to bite.
      const distanceKm =
        i === 0
          ? round1(persona.baseRideKm * 2.2)
          : round1(persona.baseRideKm * (0.6 + rng() * 0.9));
      const avgSpeed = 45 + rng() * 30;
      const durationMs = (distanceKm / avgSpeed) * 60 * 60 * 1000;
      // Spread rides chronologically across the membership window.
      const ageDays =
        (persona.joinedDaysAgo * (persona.rideCount - i)) /
          (persona.rideCount + 1) +
        rng();
      const startedAt = new Date(now.getTime() - ageDays * DAY_MS);
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
          ride_type: RIDE_TYPES[i % RIDE_TYPES.length],
          name: i % 5 === 0 ? `${persona.home_region} loop #${i + 1}` : null,
          status: 'completed',
          bike_id: bikes.length > 0 ? bikes[i % bikes.length].id : null,
        }),
      );
    }
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
      rows.push(
        repo.create({
          user_id: userId,
          road_segment_id: roads.length > 0 ? roads[i % roads.length].id : null,
          location: pointGeom(jitter(persona.home, rng, 0.05)),
          hazard_type: HAZARD_TYPES[i % HAZARD_TYPES.length],
          severity: HAZARD_SEVERITY[i % HAZARD_SEVERITY.length],
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
      rows.push(
        repo.create({
          user_id: userId,
          road_segment_id: roads[i].id,
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
    const tripRepo = this.repo(Trip);
    const dayRepo = this.repo(TripDay);
    const wpRepo = this.repo(TripWaypoint);
    const memberRepo = this.repo(TripMember);

    for (let t = 0; t < persona.tripCount; t++) {
      const numDays = 2 + Math.floor(rng() * 4);
      const trip = await tripRepo.save(
        tripRepo.create({
          owner_id: userId,
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
