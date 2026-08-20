import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppDataSource } from '../src/data-source.js';
import { DatabaseModule } from '../src/modules/database/database.module.js';
import { AuthModule } from '../src/modules/auth/index.js';
import { TripsModule } from '../src/modules/trips/index.js';
import { setupGlobalPrefix } from '../src/config/global-prefix.js';

/**
 * trip_planning kill switch on the trip-creation endpoints (#1164)
 *
 * The companion and mobile clients hide every trip-creation affordance when
 * `trip_planning` is `force_off`, but a client gate cannot stop a stale tab
 * or a direct API call. This spec proves the server is the authority:
 *
 *   1. a fresh (free-tier) rider can create a trip — the guard does NOT
 *      break the default-on resolution (`trip_planning` is granted to
 *      every tier);
 *   2. an operator `force_off` row makes `POST /trips`,
 *      `POST /trips/:tripId/duplicate`, and `POST /trips/:tripId/generate`
 *      reject with the standard `FeatureGuard` envelope
 *      (`feature: "trip_planning"`, `scope: "global"`);
 *   3. reads AND edits of an existing trip keep working while the switch
 *      is off — the deliberate #1164 decision: a rider mid-tour must not
 *      be locked out of the trip they are riding today;
 *   4. clearing the row restores creation on the next request (resolution
 *      is live — no restart, no cache).
 *
 * Deliberately scoped to `DatabaseModule` + `AuthModule` + `TripsModule`
 * (not the full `AppModule`) so it needs ONLY a migrated PostgreSQL — no
 * Redis, no seed data, no POI service — and can therefore run in CI's
 * real-postgres job against the from-zero database. The
 * `POST /rides/:rideId/clone` creation path lives in `SharingModule`,
 * whose transitive imports register BullMQ queues (Redis); its guard
 * wiring is covered by unit tests instead
 * (`sharing.controller.spec.ts`).
 *
 * Local run prerequisites: `pnpm db:up && pnpm db:migrate` before
 * `pnpm --filter @tarmoto/backend test:e2e -- trip-planning-create-guard`.
 */

const E2E_EMAIL = 'trip-planning-guard-e2e@tarmoto.app';
const E2E_PASSWORD = 'e2e-password-123!';

const FORBIDDEN_ENVELOPE = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Feature unavailable: trip_planning',
  feature: 'trip_planning',
  scope: 'global',
};

describe('trip_planning guard on trip creation (e2e, #1164)', () => {
  let app: INestApplication<App>;
  let seedDataSource: DataSource;
  let accessToken: string;
  let userId: string;
  let tripId: string;

  const cleanup = async () => {
    // Kill-switch row first: a crashed earlier run must never leave the
    // shared dev database with trip planning globally disabled.
    await seedDataSource.query(
      `DELETE FROM feature_states WHERE feature = 'trip_planning'`,
    );
    const users = await seedDataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = $1`,
      [E2E_EMAIL],
    );
    for (const user of users) {
      // trips.owner_id has no ON DELETE CASCADE; days/waypoints/members
      // cascade from trips.
      await seedDataSource.query(`DELETE FROM trips WHERE owner_id = $1`, [
        user.id,
      ]);
      await seedDataSource.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    }
  };

  beforeAll(async () => {
    // Dedicated connection for seeding/cleanup so we don't conflict with
    // the app's own TypeORM DataSource (initialised by DatabaseModule).
    seedDataSource = new DataSource(AppDataSource.options);
    await seedDataSource.initialize();
    await cleanup();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        AuthModule,
        TripsModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupGlobalPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: E2E_EMAIL,
        password: E2E_PASSWORD,
        display_name: 'Guard Probe',
      })
      .expect(201);
    accessToken = (register.body as { access_token: string }).access_token;
    expect(accessToken).toBeDefined();

    const rows = await seedDataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = $1`,
      [E2E_EMAIL],
    );
    userId = rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (seedDataSource?.isInitialized) {
      await cleanup();
    }
    await app?.close();
    if (seedDataSource?.isInitialized) {
      await seedDataSource.destroy();
    }
  }, 30_000);

  const authed = (method: 'get' | 'post' | 'patch', path: string) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${accessToken}`);

  it('lets a fresh free-tier rider create a trip while the switch is untouched', async () => {
    const res = await authed('post', '/api/v1/trips')
      .send({ title: 'Kill-switch probe', num_days: 2 })
      .expect(201);
    tripId = (res.body as { id: string }).id;
    expect(tripId).toBeDefined();
  });

  describe('with trip_planning force_off', () => {
    beforeAll(async () => {
      await seedDataSource.query(
        `INSERT INTO feature_states (feature, state, reason)
         VALUES ('trip_planning', 'force_off', 'e2e: #1164 guard probe')`,
      );
    });

    it('rejects POST /trips with the standard FeatureGuard envelope', async () => {
      const res = await authed('post', '/api/v1/trips')
        .send({ title: 'Should not exist', num_days: 1 })
        .expect(403);
      expect(res.body).toMatchObject(FORBIDDEN_ENVELOPE);
    });

    it('rejects POST /trips/:tripId/duplicate', async () => {
      const res = await authed(
        'post',
        `/api/v1/trips/${tripId}/duplicate`,
      ).expect(403);
      expect(res.body).toMatchObject(FORBIDDEN_ENVELOPE);
    });

    it('rejects POST /trips/:tripId/generate', async () => {
      const res = await authed('post', `/api/v1/trips/${tripId}/generate`)
        .send({ start_location: { lat: 47.0, lng: 11.5 } })
        .expect(403);
      expect(res.body).toMatchObject(FORBIDDEN_ENVELOPE);
    });

    it('keeps reads open — a rider can still see their trips', async () => {
      const res = await authed('get', '/api/v1/trips').expect(200);
      const ids = (res.body as { id: string }[]).map((t) => t.id);
      expect(ids).toContain(tripId);
    });

    it('keeps edits open — PATCH /trips/:tripId is deliberately unguarded (#1164 decision)', async () => {
      const res = await authed('patch', `/api/v1/trips/${tripId}`)
        .send({ title: 'Renamed mid-kill' })
        .expect(200);
      expect((res.body as { title: string }).title).toBe('Renamed mid-kill');
    });

    it('has not created any trip through the blocked attempts', async () => {
      const rows = await seedDataSource.query<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM trips WHERE owner_id = $1`,
        [userId],
      );
      expect(rows[0]!.count).toBe(1);
    });
  });

  it('restores creation on the next request once the operator clears the switch', async () => {
    await seedDataSource.query(
      `DELETE FROM feature_states WHERE feature = 'trip_planning'`,
    );
    // Free-tier `max_active_trips` now enforces its registry default of `1`
    // (the launch-mode global override was cleared by migration 1839, #1104)
    // — the probe trip from the first test already holds that slot. This
    // spec is about the `trip_planning` switch, not the trip-count limit, so
    // free the slot rather than asserting around a second, unrelated guard.
    await seedDataSource.query(`DELETE FROM trips WHERE owner_id = $1`, [
      userId,
    ]);
    await authed('post', '/api/v1/trips')
      .send({ title: 'Back in business', num_days: 1 })
      .expect(201);
  });
});
