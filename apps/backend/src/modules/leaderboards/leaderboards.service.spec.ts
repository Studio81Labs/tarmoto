/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { LeaderboardsService } from './leaderboards.service.js';

describe('LeaderboardsService', () => {
  let service: LeaderboardsService;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    dataSource = { query: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LeaderboardsService,
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(LeaderboardsService);
  });

  /**
   * Mock the three dimension queries — order matches `DIMENSIONS` in the
   * service: total_distance_km, roads_discovered, hazards_reported. Each
   * dimension issues exactly one query that returns top-N rows
   * (`extra_me: false`) optionally followed by a single me row outside the
   * top-N (`extra_me: true`).
   */
  function mockDimensions(
    distRows: object[],
    roadsRows: object[],
    hazardRows: object[],
  ): void {
    dataSource.query
      .mockResolvedValueOnce(distRows)
      .mockResolvedValueOnce(roadsRows)
      .mockResolvedValueOnce(hazardRows);
  }

  function topRow(
    overrides: Partial<{
      user_id: string;
      display_name: string;
      home_region: string | null;
      value: string | number;
      rank: string | number;
    }> = {},
  ) {
    return {
      user_id: 'u1',
      display_name: 'Rider',
      home_region: 'Beskydy',
      value: '100',
      rank: '1',
      extra_me: false,
      ...overrides,
    };
  }

  function meExtraRow(
    overrides: Partial<{
      user_id: string;
      display_name: string;
      home_region: string | null;
      value: string | number;
      rank: string | number;
    }> = {},
  ) {
    return {
      user_id: 'me',
      display_name: 'You',
      home_region: 'Beskydy',
      value: '50',
      rank: '99',
      extra_me: true,
      ...overrides,
    };
  }

  it('returns three dimensions with rows ordered by value', async () => {
    mockDimensions(
      [
        topRow({
          user_id: 'u1',
          display_name: 'Alice',
          value: '1500.5',
          rank: '1',
        }),
        topRow({ user_id: 'u2', display_name: 'Bob', value: '900', rank: '2' }),
      ],
      [topRow({ user_id: 'u2', display_name: 'Bob', value: '42', rank: '1' })],
      [],
    );

    const result = await service.getRegional({});

    expect(result.region).toBeNull();
    expect(result.total_distance_km.dimension).toBe('total_distance_km');
    expect(result.total_distance_km.unit).toBe('km');
    expect(result.total_distance_km.entries).toHaveLength(2);
    expect(result.total_distance_km.entries[0]).toEqual({
      rank: 1,
      user_id: 'u1',
      display_name: 'Alice',
      home_region: 'Beskydy',
      value: 1500.5,
    });
    expect(result.total_distance_km.me).toBeNull();

    expect(result.roads_discovered.dimension).toBe('roads_discovered');
    expect(result.roads_discovered.unit).toBe('roads');
    expect(result.roads_discovered.entries[0]!.user_id).toBe('u2');

    expect(result.hazards_reported.entries).toEqual([]);
    expect(result.hazards_reported.unit).toBe('reports');
  });

  it('passes region filter through to SQL params', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ region: '  Beskydy  ' });

    expect(dataSource.query).toHaveBeenCalledTimes(3);
    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe('Beskydy'); // trimmed region
    }
  });

  it('treats empty / whitespace region as null (global ranking)', async () => {
    mockDimensions([], [], []);

    const result = await service.getRegional({ region: '   ' });

    expect(result.region).toBeNull();
    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBeNull();
    }
  });

  it('respects limit param in SQL', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ limit: 5 });

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[1]).toBe(5);
    }
  });

  it('defaults limit to 20 when not provided', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[1]).toBe(20);
    }
  });

  it('forwards currentUserId as the third SQL param', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ currentUserId: 'me' });

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[2]).toBe('me');
    }
  });

  it('passes null currentUserId when caller is anonymous', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[2]).toBeNull();
    }
  });

  it('issues exactly one query per dimension regardless of currentUserId', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ currentUserId: 'me' });

    expect(dataSource.query).toHaveBeenCalledTimes(3);
  });

  it('returns me from the in-list row when current user is in top-N', async () => {
    mockDimensions(
      [
        topRow({
          user_id: 'u1',
          display_name: 'Alice',
          value: '1500',
          rank: '1',
        }),
        topRow({ user_id: 'me', display_name: 'You', value: '900', rank: '2' }),
      ],
      [],
      [],
    );

    const result = await service.getRegional({ currentUserId: 'me' });

    expect(result.total_distance_km.me).toEqual({
      rank: 2,
      user_id: 'me',
      display_name: 'You',
      home_region: 'Beskydy',
      value: 900,
    });
  });

  it('returns me from the appended extra-me row when current user is outside top-N', async () => {
    mockDimensions(
      [],
      [
        meExtraRow({
          user_id: 'me',
          display_name: 'You',
          value: '12',
          rank: '47',
        }),
      ],
      [],
    );

    const result = await service.getRegional({ currentUserId: 'me' });

    expect(result.roads_discovered.entries).toHaveLength(0);
    expect(result.roads_discovered.me).toEqual({
      rank: 47,
      user_id: 'me',
      display_name: 'You',
      home_region: 'Beskydy',
      value: 12,
    });
  });

  it('returns me as null when neither top-N nor extra-me row matches', async () => {
    mockDimensions([], [], []);

    const result = await service.getRegional({ currentUserId: 'me' });

    expect(result.total_distance_km.me).toBeNull();
    expect(result.roads_discovered.me).toBeNull();
    expect(result.hazards_reported.me).toBeNull();
  });

  it('exposes generated_at as an ISO string', async () => {
    mockDimensions([], [], []);

    const result = await service.getRegional({});

    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('coerces string ranks and values to numbers', async () => {
    mockDimensions(
      [
        topRow({
          user_id: 'u1',
          display_name: 'Alice',
          home_region: null,
          value: '1234.56',
          rank: '1',
        }),
      ],
      [],
      [],
    );

    const result = await service.getRegional({});

    expect(result.total_distance_km.entries[0]!.value).toBe(1234.56);
    expect(result.total_distance_km.entries[0]!.rank).toBe(1);
    expect(typeof result.total_distance_km.entries[0]!.value).toBe('number');
    expect(typeof result.total_distance_km.entries[0]!.rank).toBe('number');
  });

  it('SQL filters by privacy and soft delete', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('profile_visibility');
    expect(sql).toContain("'private'");
  });

  it('SQL uses DENSE_RANK so the "Your rank" pill skips no values after ties', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    const sql = dataSource.query.mock.calls[0][0] as string;
    // RANK() leaves gaps after ties (1, 1, 3) — for a leaderboard pill we
    // want DENSE_RANK (1, 1, 2) so a rider just past a tie doesn't see
    // their position inflated by the size of the tie group.
    expect(sql).toMatch(/DENSE_RANK\(\)/);
  });

  it('SQL inner-joins users to dim_values so inactive riders are not scanned', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    const sql = dataSource.query.mock.calls[0][0] as string;
    // Driving the FROM with `dim_values` means only riders with a row in
    // the per-dimension CTE are considered, instead of scanning every
    // non-deleted user and filtering with `WHERE value > 0` afterwards.
    expect(sql).toMatch(/FROM\s+dim_values/);
    expect(sql).toMatch(/INNER JOIN\s+users/);
    expect(sql).not.toMatch(/LEFT JOIN\s+dim_values/);
  });

  it('SQL combines top-N and me lookups in a single query per dimension', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ currentUserId: 'me' });

    const sql = dataSource.query.mock.calls[0][0] as string;
    // Single CTE pipeline (one WITH) shared by both branches of the UNION,
    // so the dim_values → eligible → ranked work runs once per dimension
    // even when a signed-in viewer needs both top-N and me rows.
    expect(sql.match(/\bWITH\b/g)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/extra_me/);
  });

  it('hazards_reported CTE excludes hidden hazard_reports (moderation_status filter)', async () => {
    mockDimensions([], [], []);

    await service.getRegional({});

    // Third query is the hazards_reported dimension — verify it carries the filter
    const hazardSql = dataSource.query.mock.calls[2][0] as string;
    expect(hazardSql).toContain("moderation_status = 'visible'");
  });

  it('SQL ORDER BY after UNION only references columns in the SELECT lists', async () => {
    mockDimensions([], [], []);

    await service.getRegional({ currentUserId: 'me' });

    const sql = dataSource.query.mock.calls[0][0] as string;
    // PostgreSQL forbids ORDER BY referencing internal CTE columns after a
    // UNION ALL — only the combined result's output columns are addressable.
    // Forgetting that would crash every request with "column rn does not
    // exist", and the mocked-DB unit tests can't catch it at runtime.
    //
    // The window function inside `ranked` also has `OVER (ORDER BY ...)`,
    // so we anchor against the last `ORDER BY` in the string — that's the
    // one applied to the UNION result.
    const lastOrderBy = sql.lastIndexOf('ORDER BY');
    expect(lastOrderBy).toBeGreaterThan(-1);
    const orderBy = sql.slice(lastOrderBy + 'ORDER BY'.length);
    // The output columns of either UNION branch are exactly these six.
    const allowed = new Set([
      'user_id',
      'display_name',
      'home_region',
      'value',
      'rank',
      'extra_me',
    ]);
    const referenced = (orderBy.match(/\b[a-z_][a-z_0-9]*\b/gi) ?? []).filter(
      (tok) => !['ASC', 'DESC', 'NULLS', 'FIRST', 'LAST'].includes(tok),
    );
    for (const tok of referenced) {
      expect(allowed.has(tok)).toBe(true);
    }
  });
});
