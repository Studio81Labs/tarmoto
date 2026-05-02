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

  function mockTopRows(
    distRows: object[],
    roadsRows: object[],
    hazardRows: object[],
  ): void {
    // Order matches the dimension order in DIMENSIONS / Promise.all:
    // total_distance_km, roads_discovered, hazards_reported.
    // Each dimension issues a single top-N query when no current user is
    // provided, or top-N + me when a user is.
    dataSource.query
      .mockResolvedValueOnce(distRows)
      .mockResolvedValueOnce(roadsRows)
      .mockResolvedValueOnce(hazardRows);
  }

  it('returns three dimensions with rows ordered by value', async () => {
    mockTopRows(
      [
        {
          user_id: 'u1',
          display_name: 'Alice',
          home_region: 'Beskydy',
          value: '1500.5',
          rank: '1',
        },
        {
          user_id: 'u2',
          display_name: 'Bob',
          home_region: 'Beskydy',
          value: '900',
          rank: '2',
        },
      ],
      [
        {
          user_id: 'u2',
          display_name: 'Bob',
          home_region: 'Beskydy',
          value: '42',
          rank: '1',
        },
      ],
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
    expect(result.roads_discovered.entries[0].user_id).toBe('u2');

    expect(result.hazards_reported.entries).toEqual([]);
    expect(result.hazards_reported.unit).toBe('reports');
  });

  it('passes region filter through to SQL params', async () => {
    mockTopRows([], [], []);

    await service.getRegional({ region: '  Beskydy  ' });

    expect(dataSource.query).toHaveBeenCalledTimes(3);
    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe('Beskydy'); // trimmed region
    }
  });

  it('treats empty / whitespace region as null (global ranking)', async () => {
    mockTopRows([], [], []);

    const result = await service.getRegional({ region: '   ' });

    expect(result.region).toBeNull();
    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBeNull();
    }
  });

  it('respects limit param in SQL', async () => {
    mockTopRows([], [], []);

    await service.getRegional({ limit: 5 });

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[1]).toBe(5);
    }
  });

  it('defaults limit to 20 when not provided', async () => {
    mockTopRows([], [], []);

    await service.getRegional({});

    for (const call of dataSource.query.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[1]).toBe(20);
    }
  });

  it('returns me from top-N when current user is in the list', async () => {
    // With currentUserId set, the service runs top-N + me query per dim.
    // We mock both calls in order.
    dataSource.query
      // total_distance_km: top-N
      .mockResolvedValueOnce([
        {
          user_id: 'u1',
          display_name: 'Alice',
          home_region: 'Beskydy',
          value: '1500',
          rank: '1',
        },
        {
          user_id: 'me',
          display_name: 'You',
          home_region: 'Beskydy',
          value: '900',
          rank: '2',
        },
      ])
      // total_distance_km: me query (still runs even if user is in top-N
      // — but its result is ignored when meFromTop is found).
      .mockResolvedValueOnce([
        {
          user_id: 'me',
          display_name: 'You',
          home_region: 'Beskydy',
          value: '900',
          rank: '2',
        },
      ])
      // roads_discovered: top-N empty → me query result is used.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          user_id: 'me',
          display_name: 'You',
          home_region: 'Beskydy',
          value: '12',
          rank: '47',
        },
      ])
      // hazards_reported: both empty → me is null.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.getRegional({ currentUserId: 'me' });

    expect(result.total_distance_km.me).toEqual({
      rank: 2,
      user_id: 'me',
      display_name: 'You',
      home_region: 'Beskydy',
      value: 900,
    });
    expect(result.roads_discovered.me).toEqual({
      rank: 47,
      user_id: 'me',
      display_name: 'You',
      home_region: 'Beskydy',
      value: 12,
    });
    expect(result.roads_discovered.entries).toHaveLength(0);
    expect(result.hazards_reported.me).toBeNull();
  });

  it('skips me query when no current user is given', async () => {
    mockTopRows([], [], []);

    await service.getRegional({});

    // 3 dims × 1 query each (no me query)
    expect(dataSource.query).toHaveBeenCalledTimes(3);
  });

  it('exposes generated_at as an ISO string', async () => {
    mockTopRows([], [], []);

    const result = await service.getRegional({});

    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('coerces string ranks and values to numbers', async () => {
    mockTopRows(
      [
        {
          user_id: 'u1',
          display_name: 'Alice',
          home_region: null,
          value: '1234.56',
          rank: '1',
        },
      ],
      [],
      [],
    );

    const result = await service.getRegional({});

    expect(result.total_distance_km.entries[0].value).toBe(1234.56);
    expect(result.total_distance_km.entries[0].rank).toBe(1);
    expect(typeof result.total_distance_km.entries[0].value).toBe('number');
    expect(typeof result.total_distance_km.entries[0].rank).toBe('number');
  });

  it('SQL filters by privacy and soft delete', async () => {
    mockTopRows([], [], []);

    await service.getRegional({});

    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('profile_visibility');
    expect(sql).toContain("'private'");
  });

  it('SQL inner-joins users to dim_values so inactive riders are not scanned', async () => {
    mockTopRows([], [], []);

    await service.getRegional({});

    const sql = dataSource.query.mock.calls[0][0] as string;
    // Driving the FROM with `dim_values` means only riders with a row in
    // the per-dimension CTE are considered, instead of scanning every
    // non-deleted user and filtering with `WHERE value > 0` afterwards.
    expect(sql).toMatch(/FROM\s+dim_values/);
    expect(sql).toMatch(/INNER JOIN\s+users/);
    expect(sql).not.toMatch(/LEFT JOIN\s+dim_values/);
  });
});
