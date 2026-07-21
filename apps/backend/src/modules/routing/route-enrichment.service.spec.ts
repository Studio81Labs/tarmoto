import { RouteEnrichmentService } from './route-enrichment.service.js';
import type { DataSource } from 'typeorm';

describe('RouteEnrichmentService.aggregate', () => {
  it('maps the three PostGIS rows into RouteMetrics', async () => {
    const query = jest
      .fn()
      // Bounded road-sampling aggregate.
      .mockResolvedValueOnce([
        {
          avg_quality: 4.0,
          avg_curviness: 6.1,
          elevation_span: 540,
          total_length_m: 88900,
          surface_mix: { asphalt: 82000, gravel: 6900 },
        },
      ])
      // hazard rows
      .mockResolvedValueOnce([{ count: 0 }])
      // scenic rows
      .mockResolvedValueOnce([{ avg_scenic: 3.2, zone_count: 2 }]);
    const ds = { query } as unknown as DataSource;

    const m = await new RouteEnrichmentService(ds).aggregate([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    expect(m.avgQuality).toBe(4.0);
    expect(m.curvinessScore).toBe(6.1);
    expect(m.elevationGain).toBe(540);
    expect(m.surfaceMixMetres).toEqual({ asphalt: 82000, gravel: 6900 });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('hazard count query excludes hidden hazards (moderation_status filter)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          avg_quality: 3.5,
          avg_curviness: 4.0,
          elevation_span: 200,
          total_length_m: 10000,
          surface_mix: '{}',
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ avg_scenic: null, zone_count: 0 }]);
    const ds = { query } as unknown as DataSource;

    await new RouteEnrichmentService(ds).aggregate([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    // Second query issued is the hazard count — check it carries both the
    // cheap geometry-index prefilter and exact geography-distance predicate.
    const hazardSql = String((query.mock.calls[1] as unknown[])[0]);
    expect(hazardSql).toContain("moderation_status = 'visible'");
    expect(hazardSql).toContain('h.location && ST_Expand');
    expect(hazardSql).toContain('h.location::geography');

    const scenicSql = String((query.mock.calls[2] as unknown[])[0]);
    expect(scenicSql).toContain('fz.boundary && ST_Expand');
    expect(scenicSql).toContain('fz.boundary::geography');
  });

  it('uses latitude-safe envelopes for every enrichment prefilter', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          avg_quality: null,
          avg_curviness: null,
          elevation_span: null,
          total_length_m: null,
          surface_mix: {},
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ avg_scenic: null, zone_count: 0 }]);
    const ds = { query } as unknown as DataSource;

    await new RouteEnrichmentService(ds).aggregate([
      { lat: 70, lng: 20 },
      { lat: 70.1, lng: 20.1 },
    ]);

    const calls = query.mock.calls as [string, unknown[]][];
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toContain('rs.geom && ST_Expand');
    expect(calls[1]?.[0]).toContain('h.location && ST_Expand');
    expect(calls[2]?.[0]).toContain('fz.boundary && ST_Expand');
    expect(calls[0]?.[1][4] as number).toBeGreaterThan(0.0025);
    expect(calls[1]?.[1][2] as number).toBeGreaterThan(0.0125);
    expect(calls[2]?.[1][2] as number).toBeGreaterThan(0.0125);
  });

  it('bounds long-route work with capped point-local GiST lookups', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          avg_quality: null,
          avg_curviness: null,
          elevation_span: null,
          total_length_m: null,
          surface_mix: {},
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ avg_scenic: null, zone_count: 0 }]);
    const ds = { query } as unknown as DataSource;

    await new RouteEnrichmentService(ds).aggregate(
      Array.from({ length: 2_000 }, (_, i) => ({
        lat: 49 + i * 0.0001,
        lng: 14 + i * 0.0002,
      })),
    );

    const roadSql = String((query.mock.calls[0] as unknown[])[0]);
    const roadParams = (query.mock.calls[0] as unknown[])[1];
    expect(roadSql).toContain('LEAST(\n                 $3::int');
    expect(roadSql).toContain('generate_series(');
    expect(roadSql).toContain('sampling.sample_count - 1');
    expect(roadSql).toContain('LEFT JOIN LATERAL');
    expect(roadSql).toContain('rs.geom && ST_Expand');
    expect(roadSql).toContain('rs.geom::geography');
    expect(roadSql).toContain("COALESCE(surface_type, 'unknown')");
    // The cap and minimum spacing are bound parameters, so route length cannot
    // grow the number of nearest-segment index lookups without bound.
    expect(roadParams).toEqual([
      expect.any(String),
      100,
      2500,
      40,
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('returns empty metrics without querying for degenerate geometry', async () => {
    const query = jest.fn();
    const ds = { query } as unknown as DataSource;
    const svc = new RouteEnrichmentService(ds);

    // Fewer than 2 finite points (single point, and a NaN/empty case) would
    // produce invalid WKT — these must short-circuit before any PostGIS query.
    for (const geometry of [
      [{ lat: 50.08, lng: 14.42 }],
      [
        { lat: Number.NaN, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      [],
    ]) {
      const m = await svc.aggregate(geometry);
      expect(m).toEqual({
        avgQuality: null,
        curvinessScore: null,
        scenicScore: null,
        elevationGain: 0,
        elevationLoss: 0,
        hazardCount: 0,
        surfaceMixMetres: {},
      });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('cancels active Postgres queries when the request is aborted', async () => {
    const pending = new Map<number, (reason: Error) => void>();
    let startedCount = 0;
    let allStartedResolve: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      allStartedResolve = resolve;
    });
    const runners = [101, 102, 103].map((pid) => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn((sql: string) => {
          if (sql.includes('pg_backend_pid')) {
            return Promise.resolve([{ pid, application_name: 'tarmoto' }]);
          }
          if (sql.includes('set_config')) {
            return Promise.resolve([{ set_config: 'tarmoto' }]);
          }
          startedCount += 1;
          if (startedCount === 3) allStartedResolve?.();
          return new Promise<never>((_resolve, reject) => {
            pending.set(pid, reject);
          });
        }),
        release: jest.fn().mockResolvedValue(undefined),
      };
      return runner;
    });
    const cancelQuery = jest.fn(
      (_sql: string, params: unknown[] | undefined) => {
        const pid = params?.[0] as number;
        pending.get(pid)?.(
          new Error('canceling statement due to user request'),
        );
        return Promise.resolve([{ cancelled: true }]);
      },
    );
    const createQueryRunner = jest
      .fn()
      .mockReturnValueOnce(runners[0])
      .mockReturnValueOnce(runners[1])
      .mockReturnValueOnce(runners[2]);
    const ds = {
      query: cancelQuery,
      createQueryRunner,
    } as unknown as DataSource;
    const controller = new AbortController();

    const aggregate = new RouteEnrichmentService(ds).aggregate(
      [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      controller.signal,
    );
    await allStarted;
    controller.abort();

    await expect(aggregate).rejects.toThrow(
      'canceling statement due to user request',
    );
    expect(cancelQuery).toHaveBeenCalledTimes(3);
    for (const pid of [101, 102, 103]) {
      expect(cancelQuery).toHaveBeenCalledWith(
        expect.stringContaining('pg_cancel_backend'),
        [pid, expect.stringMatching(/^tarmoto-route-enrichment:/)],
      );
    }
    expect(
      runners.every((runner) => runner.release.mock.calls.length === 1),
    ).toBe(true);
  });

  it('releases a completed runner without waiting for a pool-backed cancel', async () => {
    let resolveStatement: ((value: unknown[]) => void) | undefined;
    let statementStartedResolve: (() => void) | undefined;
    const statementStarted = new Promise<void>((resolve) => {
      statementStartedResolve = resolve;
    });
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_backend_pid')) {
          return Promise.resolve([{ pid: 101, application_name: 'tarmoto' }]);
        }
        if (sql.includes('set_config')) {
          return Promise.resolve([{ set_config: 'tarmoto' }]);
        }
        statementStartedResolve?.();
        return new Promise<unknown[]>((resolve) => {
          resolveStatement = resolve;
        });
      }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const queuedCancel = new Promise<never>(() => undefined);
    const ds = {
      query: jest.fn().mockReturnValue(queuedCancel),
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as unknown as DataSource;
    const controller = new AbortController();
    const service = new RouteEnrichmentService(ds);
    const query = (
      service as unknown as {
        query<T>(
          sql: string,
          params: unknown[],
          signal?: AbortSignal,
        ): Promise<T>;
      }
    ).query<unknown[]>('SELECT 1', [], controller.signal);

    await statementStarted;
    controller.abort();
    resolveStatement?.([]);

    await expect(query).resolves.toEqual([]);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(runner.query).toHaveBeenLastCalledWith(
      expect.stringContaining('set_config'),
      ['tarmoto'],
    );
  });
});
