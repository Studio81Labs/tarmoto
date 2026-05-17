import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AppDataSource } from '../src/data-source.js';
import { HazardsService } from '../src/modules/hazards/hazards.service.js';
import { HazardReport } from '../src/entities/hazard-report.entity.js';
import { CommuteRoute } from '../src/entities/commute-route.entity.js';
import { EventsGateway } from '../src/modules/events/events.gateway.js';
import { PushService } from '../src/modules/push/push.service.js';
import { PrivacyPreferencesService } from '../src/modules/account/privacy-preferences.service.js';

/**
 * Issue #555 — `GET /hazards?lat=...&lng=...&radius=...` returned
 * 500 in `/explore`. Root cause was a migration timestamp collision
 * between #362 (this column) and #364 (`AddHomeRegionIndex`); only
 * the latter got registered in `data-source.ts`, so the
 * `photo_url` column referenced by `HAZARD_SELECT_BASE` was missing
 * in every environment where the chain had been applied from
 * scratch.
 *
 * This test runs `findNearby` against the live database for an
 * empty query so the column-resolution path is exercised but no
 * seed data is needed. A future regression that drops the column
 * (or skips registering a corresponding migration) would fail this
 * test against the bare migrations chain.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */
describe('hazards: GET /hazards findNearby — column resolution (#555)', () => {
  let module: TestingModule;
  let service: HazardsService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(AppDataSource.options),
        TypeOrmModule.forFeature([HazardReport, CommuteRoute]),
      ],
      providers: [
        HazardsService,
        // The collaborators are touched on the write paths, not
        // `findNearby`, so noop stubs are enough.
        { provide: EventsGateway, useValue: { emit: () => undefined } },
        {
          provide: PushService,
          useValue: { sendToUsers: () => Promise.resolve() },
        },
        {
          provide: PrivacyPreferencesService,
          useValue: { loadPreferences: () => Promise.resolve({}) },
        },
      ],
    }).compile();

    service = module.get(HazardsService);
    dataSource = module.get(getDataSourceToken());
  }, 30_000);

  afterAll(async () => {
    await module?.close();
  });

  it('resolves the SELECT (including photo_url) without throwing on an empty query', async () => {
    // Centred far from any seeded hazards so the empty-result
    // path is the typical case — the bug surfaces during column
    // resolution, before any rows would be returned.
    const result = await service.findNearby({
      lat: 0,
      lng: 0,
      radius: 1_000,
    });
    expect(Array.isArray(result)).toBe(true);
    // Sanity check that the DB schema actually has the column the
    // migration adds — `\d hazard_reports` via SQL.
    const rows = (await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'hazard_reports' AND column_name = 'photo_url'`,
    )) as { column_name: string }[];
    expect(rows).toHaveLength(1);
  });
});
