import { RouteEnrichmentService } from './route-enrichment.service.js';
import type { DataSource } from 'typeorm';

describe('RouteEnrichmentService.aggregate', () => {
  it('maps the four PostGIS rows into RouteMetrics', async () => {
    const query = jest
      .fn()
      // quality row
      .mockResolvedValueOnce([
        {
          avg_quality: 4.0,
          avg_curviness: 6.1,
          elevation_span: 540,
          total_length_m: 88900,
        },
      ])
      // surface rows
      .mockResolvedValueOnce([
        { surface_type: 'asphalt', length_m: 82000 },
        { surface_type: 'gravel', length_m: 6900 },
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
    expect(query).toHaveBeenCalledTimes(4);
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
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ avg_scenic: null, zone_count: 0 }]);
    const ds = { query } as unknown as DataSource;

    await new RouteEnrichmentService(ds).aggregate([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    // Third query issued is the hazard count — check it carries the moderation filter
    const hazardSql = String(query.mock.calls[2][0]);
    expect(hazardSql).toContain("moderation_status = 'visible'");
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
});
