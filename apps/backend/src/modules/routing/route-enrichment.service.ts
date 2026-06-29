import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface RouteMetrics {
  avgQuality: number | null;
  curvinessScore: number | null;
  scenicScore: number | null;
  elevationGain: number;
  elevationLoss: number;
  hazardCount: number;
  /** Road-segment lengths grouped by `surface_type`, in **metres**. */
  surfaceMixMetres: Record<string, number>;
}

/**
 * Buffer (metres) for ST_DWithin queries that intersect a route line
 * with `road_segments`. 100m matches the `commute` module's quality
 * lookup — narrow enough to filter out segments parallel to the route
 * but wide enough to catch the slight offset between OSRM's geometry
 * and our segment table.
 */
const ROAD_BUFFER_M = 100;

/**
 * Same buffer rule as the commute module — half a kilometre captures
 * hazards that are visible from the road without flagging stuff several
 * blocks away.
 */
const HAZARD_BUFFER_M = 500;

/**
 * Buffer (km) for fun-zone overlap. Zones are polygons rather than
 * lines, so we measure overlap of the route with the zone's boundary
 * rather than a perpendicular distance.
 */
const SCENIC_OVERLAP_BUFFER_KM = 0.5;

function geometryToWkt(
  geometry: ReadonlyArray<{ lat: number; lng: number }>,
): string {
  const coords = geometry
    .map((p) => `${Number(p.lng)} ${Number(p.lat)}`)
    .join(',');
  return `LINESTRING(${coords})`;
}

@Injectable()
export class RouteEnrichmentService {
  constructor(private readonly dataSource: DataSource) {}

  async aggregate(
    geometry: ReadonlyArray<{ lat: number; lng: number }>,
  ): Promise<RouteMetrics> {
    // Guard against degenerate/malformed geometry (snap-collapsed identical
    // points, NaN/Inf coords, or fewer than 2 points): geometryToWkt would
    // otherwise emit invalid WKT (`LINESTRING()` / `LINESTRING(NaN NaN)`) and
    // the PostGIS ST_DWithin queries would 500. Degrade to empty metrics so the
    // live-route + save paths return a clean no-enrichment result instead.
    const finite = geometry.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
    );
    if (finite.length < 2) {
      return {
        avgQuality: null,
        curvinessScore: null,
        scenicScore: null,
        elevationGain: 0,
        elevationLoss: 0,
        hazardCount: 0,
        surfaceMixMetres: {},
      };
    }
    const wkt = geometryToWkt(finite);

    type QualityRow = {
      avg_quality: number | null;
      avg_curviness: number | null;
      elevation_span: number | null;
      total_length_m: number | null;
    };
    type SurfaceRow = { surface_type: string; length_m: number };
    type HazardRow = { count: number };
    type ScenicRow = { avg_scenic: number | null; zone_count: number };

    // One round-trip per metric — could be combined into a CTE later,
    // but for typical day lengths (<500 km) the four queries each return
    // in <50 ms on the index.
    const [qualityRows, surfaceRows, hazardRows, scenicRows] =
      (await Promise.all([
        this.dataSource.query(
          `SELECT
             AVG(rs.quality_score)::float AS avg_quality,
             AVG(rs.curviness_score)::float AS avg_curviness,
             SUM(GREATEST(rs.elevation_max - rs.elevation_min, 0))::float AS elevation_span,
             SUM(rs.length_m)::float AS total_length_m
           FROM road_segments rs
           WHERE rs.quality_score IS NOT NULL
             AND ST_DWithin(
               rs.geom::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )`,
          [wkt, ROAD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT rs.surface_type, SUM(rs.length_m)::float AS length_m
           FROM road_segments rs
           WHERE ST_DWithin(
             rs.geom::geography,
             ST_GeomFromText($1, 4326)::geography,
             $2
           )
           GROUP BY rs.surface_type`,
          [wkt, ROAD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count
           FROM hazard_reports h
           WHERE h.is_active = true AND h.expires_at > NOW()
             AND h.moderation_status = 'visible'
             AND ST_DWithin(
               h.location::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )`,
          [wkt, HAZARD_BUFFER_M],
        ),
        this.dataSource.query(
          `SELECT
             AVG(fz.composite_score)::float AS avg_scenic,
             COUNT(*)::int AS zone_count
           FROM fun_zones fz
           WHERE ST_DWithin(
             fz.boundary::geography,
             ST_GeomFromText($1, 4326)::geography,
             $2
           )`,
          [wkt, SCENIC_OVERLAP_BUFFER_KM * 1000],
        ),
      ])) as [QualityRow[], SurfaceRow[], HazardRow[], ScenicRow[]];

    const q: QualityRow | undefined = qualityRows[0];
    const s: ScenicRow | undefined = scenicRows[0];
    const h: HazardRow | undefined = hazardRows[0];
    const surfaceMixMetres: Record<string, number> = {};
    for (const row of surfaceRows) {
      surfaceMixMetres[row.surface_type] = row.length_m;
    }

    // Elevation gain/loss: we don't have a pre-aggregated profile per
    // route, so use the sum of segment elevation spans as an upper-bound
    // proxy — plenty good for a day card and consistent with what the
    // road-segment elevation columns already report. For a loop trip
    // total descent equals total ascent so this is exact; for a one-way
    // day it's an over-estimate. The contract is documented on
    // `TripDayDto.elevation_loss` so mobile/companion consumers know
    // the value mirrors `elevation_gain` until a real elevation profile
    // API lands.
    const elevationSpan = q?.elevation_span ?? 0;
    const elevationGain = elevationSpan;
    const elevationLoss = elevationSpan;

    const avgQuality = q?.avg_quality ?? null;
    const curvinessScore = q?.avg_curviness ?? null;
    const zoneCount = s?.zone_count ?? 0;
    const scenicAvg = s?.avg_scenic ?? null;
    // Map fun-zone aggregate into a 0..100 scenic score with a real
    // gradient. The previous `avgScore * min(count, 4) * 25` formula
    // saturated at 100 for any zone with composite_score >= 4 (US-6
    // produces scores in roughly the 1..10 range), so an option that
    // overlapped one good zone could not be distinguished from one
    // overlapping five great zones — defeating the "scenic sweep"
    // preset's whole job. Split the score into:
    //   • up to 70 points from the *quality* of zones touched
    //     (composite_score normalised against an expected ~10 ceiling)
    //   • up to 30 points from the *count* of distinct zones touched
    //     (capped at 5 so a single high-density region can't dominate)
    // The sum is still clamped to 100 so the value stays comparable to
    // `quality_score`/`curviness_score` in the same weight bands.
    const scenicScore =
      scenicAvg !== null && zoneCount > 0
        ? Math.min(
            100,
            Math.min(scenicAvg, 10) * 7 + Math.min(zoneCount, 5) * 6,
          )
        : 0;
    const hazardCount = h?.count ?? 0;

    return {
      avgQuality,
      curvinessScore,
      scenicScore,
      elevationGain,
      elevationLoss,
      hazardCount,
      surfaceMixMetres,
    };
  }
}
