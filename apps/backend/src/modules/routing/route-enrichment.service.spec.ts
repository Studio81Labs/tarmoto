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
});
