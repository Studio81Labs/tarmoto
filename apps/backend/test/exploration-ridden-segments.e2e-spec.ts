import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { AppDataSource } from '../src/data-source.js';
import { ExplorationService } from '../src/modules/exploration/exploration.service.js';
import { RideSegment } from '../src/entities/ride-segment.entity.js';
import { RoadSegment } from '../src/entities/road-segment.entity.js';
import { Ride } from '../src/entities/ride.entity.js';
import { PrivacyPreferencesService } from '../src/modules/account/privacy-preferences.service.js';
import { FeatureResolver } from '../src/modules/features/feature-resolver.service.js';

/**
 * Issue #557 — `GET /api/v1/exploration/ridden-segments` returned
 * 500 in production. The unit tests passed because they mock the
 * QueryBuilder, but the generated SQL is invalid: inlining
 * `DISTINCT ON (...)` into the first `.select()` expression let
 * TypeORM reorder the SELECT list and produce `SELECT
 * "rs2"."quality_reading", DISTINCT ON (...) ...` which Postgres
 * rejects with `syntax error at or near "DISTINCT"`. The fix
 * switches the subquery to TypeORM's native `.distinctOn(...)`
 * API; this test executes the real query against the live
 * database so a future inline-DISTINCT regression can't sneak
 * past CI again.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('exploration: GET /ridden-segments — query executes (#557)', () => {
  let module: TestingModule;
  let service: ExplorationService;
  let dataSource: DataSource;
  let userId: string | undefined;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([RideSegment, RoadSegment, Ride]),
      ],
      providers: [
        ExplorationService,
        {
          provide: PrivacyPreferencesService,
          // Exploration only consults privacy prefs for the
          // `getNearbyUnridden` path; `getRiddenSegments` doesn't
          // touch it, so a stub is enough.
          useValue: { loadPreferences: () => Promise.resolve({}) },
        },
        {
          // ExplorationService now depends on FeatureResolver (the
          // sys_gamification gate); this regression test exercises the real
          // getRiddenSegments query with the switch on (default).
          provide: FeatureResolver,
          useValue: { isSystemSwitchEnabled: () => Promise.resolve(true) },
        },
      ],
    }).compile();

    service = module.get(ExplorationService);
    dataSource = module.get(getDataSourceToken());
  }, 30_000);

  afterAll(async () => {
    if (userId) {
      await dataSource.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await module?.close();
  });

  it('returns an empty list for a user with no completed rides without throwing', async () => {
    // Insert a minimal user row so the FK-bound query has a real
    // user id to query against — distinct on / order by behaves
    // the same whether the user has rides or not, so empty is
    // the cheapest reproduction.
    const rows = await dataSource.query<{ id: string }[]>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        `exploration-ridden-${Date.now()}@example.test`,
        'x',
        'Exploration Test User',
      ],
    );
    userId = rows[0]?.id;
    if (!userId) throw new Error('failed to insert test user');

    const result = await service.getRiddenSegments(userId);
    expect(result.segments).toEqual([]);
  });
});
