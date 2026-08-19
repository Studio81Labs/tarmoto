import * as bcrypt from 'bcrypt';
import {
  DataSource,
  type DataSourceOptions,
  In,
  IsNull,
  Like,
  Not,
} from 'typeorm';
import * as AllEntities from '../src/entities/index.js';
import { AppDataSource } from '../src/data-source.js';
import { BadgesService } from '../src/modules/badges/badges.service.js';
import { FeatureResolver } from '../src/modules/features/feature-resolver.service.js';
import { DemoSeeder } from '../src/scripts/demo-seed/demo-seeder.js';
import {
  DEMO_PERSONAS,
  DEMO_PREFERENCE_FLAG,
  demoPasswordFor,
} from '../src/scripts/demo-seed/demo-personas.js';
import { UserBadge } from '../src/entities/user-badge.entity.js';
import { UserFollow } from '../src/entities/user-follow.entity.js';
import { Ride } from '../src/entities/ride.entity.js';
import { RideSegment } from '../src/entities/ride-segment.entity.js';
import { HazardReport } from '../src/entities/hazard-report.entity.js';
import { RoadReview } from '../src/entities/road-review.entity.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';
import { DEMO_ROAD_LIKE } from '../src/scripts/demo-seed/demo-data-builders.js';
import { SharedRide } from '../src/entities/shared-ride.entity.js';
import { Trip } from '../src/entities/trip.entity.js';
import { TripFolder } from '../src/entities/trip-folder.entity.js';
import { User } from '../src/entities/user.entity.js';

/**
 * Integration test for the demo-data seeder. Runs against the live
 * database (the same one the script targets), so it needs:
 *   pnpm db:up && pnpm db:migrate
 * before `pnpm --filter @tarmoto/backend test:e2e`.
 *
 * Uses a standalone DataSource registered with the full entity barrel
 * (rather than booting AppModule) so the badge relations resolve without
 * starting Redis/BullMQ/schedulers. The seeder is still exercised through
 * its real `BadgesService` collaborator, so awarded badges go through the
 * production badge rules.
 */
const DEMO_EMAILS = DEMO_PERSONAS.map((p) => p.email);

describe('seed-demo-data: DemoSeeder (integration)', () => {
  let ds: DataSource;
  let seeder: DemoSeeder;

  beforeAll(async () => {
    ds = new DataSource({
      ...AppDataSource.options,
      entities: Object.values(AllEntities) as DataSourceOptions['entities'],
      // Spreading the driver-options union re-widens optional members to
      // `T | undefined`, which exactOptionalPropertyTypes rejects.
    } as DataSourceOptions);
    await ds.initialize();
    const badges = new BadgesService(
      ds.getRepository(UserBadge),
      ds.getRepository(Ride),
      ds.getRepository(RideSegment),
      ds.getRepository(HazardReport),
      ds.getRepository(RoadReview),
      ds.getRepository(SharedRide),
      ds,
      // BadgesService now depends on FeatureResolver (the sys_gamification
      // gate); the seeder's checkAndAward path needs it on so demo badges are
      // awarded as the integration assertions expect.
      {
        isSystemSwitchEnabled: () => Promise.resolve(true),
      } as unknown as FeatureResolver,
    );
    seeder = new DemoSeeder(ds, badges);
    await seeder.run({ only: null });
  }, 120_000);

  afterAll(async () => {
    await seeder?.clean();
    if (ds?.isInitialized) await ds.destroy();
  });

  const userByEmail = (email: string) =>
    ds.getRepository(User).findOneOrFail({ where: { email } });

  const demoUserCount = () =>
    ds.getRepository(User).count({ where: { email: In(DEMO_EMAILS) } });

  it('creates every demo persona with a verified, demo-flagged account', async () => {
    for (const persona of DEMO_PERSONAS) {
      const user = await userByEmail(persona.email);
      expect(user.email_verified_at).not.toBeNull();
      expect(user.subscription_tier).toBe(persona.subscription_tier);
      expect(user.preferences?.[DEMO_PREFERENCE_FLAG]).toBe(true);
    }
  });

  it('hashes each account password (its own email) with bcrypt', async () => {
    const user = await ds
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect('u.password_hash')
      .where('u.email = :email', { email: 'newbie@tarmoto.app' })
      .getOneOrFail();
    // The login path runs exactly this compare; the password is the email.
    expect(
      await bcrypt.compare(demoPasswordFor(user), user.password_hash),
    ).toBe(true);
  });

  it('leaves the fresh newbie without any badges', async () => {
    const newbie = await userByEmail('newbie@tarmoto.app');
    const badges = await ds
      .getRepository(UserBadge)
      .count({ where: { user_id: newbie.id } });
    expect(badges).toBe(0);
  });

  it('awards the road hunter at least one gold badge', async () => {
    const hunter = await userByEmail('road.hunter@tarmoto.app');
    const badges = await ds
      .getRepository(UserBadge)
      .find({ where: { user_id: hunter.id } });
    expect(badges.some((b) => b.tier === 'gold')).toBe(true);
  });

  it('links enough distinct roads for the hunter to earn the gold explorer badge', async () => {
    const hunter = await userByEmail('road.hunter@tarmoto.app');
    const row = await ds
      .getRepository(RideSegment)
      .createQueryBuilder('rs')
      .select('COUNT(DISTINCT rs.road_segment_id)', 'count')
      .innerJoin('rs.ride', 'r')
      .where('r.user_id = :userId', { userId: hunter.id })
      .andWhere("r.status = 'completed'")
      .getRawOne<{ count: string }>();
    expect(parseInt(row!.count, 10)).toBeGreaterThanOrEqual(500);
  });

  it('shares exactly the configured number of the hunter rides', async () => {
    const hunter = await userByEmail('road.hunter@tarmoto.app');
    const persona = DEMO_PERSONAS.find(
      (p) => p.email === 'road.hunter@tarmoto.app',
    )!;
    const shared = await ds
      .getRepository(SharedRide)
      .count({ where: { user_id: hunter.id } });
    expect(shared).toBe(persona.sharedRideCount);
  });

  it('files some trip-planner trips into folders and leaves some unfiled (US-37)', async () => {
    const planner = await userByEmail('trip.planner@tarmoto.app');
    const folders = await ds
      .getRepository(TripFolder)
      .count({ where: { user_id: planner.id } });
    expect(folders).toBeGreaterThan(0);
    const tripRepo = ds.getRepository(Trip);
    const filed = await tripRepo.count({
      where: { owner_id: planner.id, folder_id: Not(IsNull()) },
    });
    const unfiled = await tripRepo.count({
      where: { owner_id: planner.id, folder_id: IsNull() },
    });
    expect(filed).toBeGreaterThan(0);
    expect(unfiled).toBeGreaterThan(0);
  });

  it('records the configured follow edges', async () => {
    const newbie = await userByEmail('newbie@tarmoto.app');
    const hunter = await userByEmail('road.hunter@tarmoto.app');
    const edge = await ds.getRepository(UserFollow).findOne({
      where: { follower_id: newbie.id, following_id: hunter.id },
    });
    expect(edge).not.toBeNull();
  });

  it('rebuilds the follow graph (both directions) after an --only reseed', async () => {
    // Reseeding one persona deletes + recreates it (new id), cascading away
    // every follow edge touching it. The graph must come back intact.
    await seeder.run({ only: 'road.hunter@tarmoto.app' });
    const hunter = await userByEmail('road.hunter@tarmoto.app');
    const scout = await userByEmail('community.scout@tarmoto.app');
    const weekend = await userByEmail('weekend.warrior@tarmoto.app');
    const followRepo = ds.getRepository(UserFollow);
    // Incoming: community.scout follows road.hunter.
    expect(
      await followRepo.findOne({
        where: { follower_id: scout.id, following_id: hunter.id },
      }),
    ).not.toBeNull();
    // Outgoing: road.hunter follows weekend.warrior.
    expect(
      await followRepo.findOne({
        where: { follower_id: hunter.id, following_id: weekend.id },
      }),
    ).not.toBeNull();
  }, 120_000);

  it('is idempotent — a second run does not duplicate accounts', async () => {
    await seeder.run({ only: null });
    expect(await demoUserCount()).toBe(DEMO_PERSONAS.length);
  }, 120_000);

  it('rolls back cleanup atomically when a non-demo row references a demo road', async () => {
    // A non-demo account reviews a shared demo road. The road delete then
    // fails on the RESTRICT FK; cleanup must roll back so the demo accounts
    // are NOT left orphaned (a non-re-runnable half-clean).
    const roadRepo = ds.getRepository(RoadSegment);
    const userRepo = ds.getRepository(User);
    const reviewRepo = ds.getRepository(RoadReview);
    const demoRoad = await roadRepo.findOneOrFail({
      where: { road_number: Like(DEMO_ROAD_LIKE) },
    });
    const outsider = await userRepo.save(
      userRepo.create({
        email: 'outsider-not-demo@example.com',
        password_hash: 'x',
        display_name: 'Outsider',
      }),
    );
    const review = await reviewRepo.save(
      reviewRepo.create({
        user_id: outsider.id,
        road_segment_id: demoRoad.id,
        rating: 4,
      }),
    );
    try {
      await expect(seeder.clean()).rejects.toThrow();
      // Demo accounts survived the rolled-back transaction.
      expect(await demoUserCount()).toBe(DEMO_PERSONAS.length);
    } finally {
      await reviewRepo.delete(review.id);
      await userRepo.delete(outsider.id);
    }
  }, 120_000);

  it('clean() removes all demo accounts and demo roads', async () => {
    const result = await seeder.clean();
    expect(result.usersDeleted).toBe(DEMO_PERSONAS.length);
    expect(await demoUserCount()).toBe(0);
    const roads = await ds
      .getRepository(RoadSegment)
      .createQueryBuilder('r')
      .where('r.road_number LIKE :pattern', { pattern: DEMO_ROAD_LIKE })
      .getCount();
    expect(roads).toBe(0);
    // Re-seed so afterAll's clean() tears down a consistent state.
    await seeder.run({ only: null });
  }, 120_000);
});
