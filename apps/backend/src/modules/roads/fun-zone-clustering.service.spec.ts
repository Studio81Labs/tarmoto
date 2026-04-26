import {
  FUN_ZONE_SCORE_REFERENCES,
  FUN_ZONE_SCORE_WEIGHTS,
  FunZoneClusteringService,
} from './fun-zone-clustering.service.js';

describe('FunZoneClusteringService scoring helpers', () => {
  describe('clamp01', () => {
    it('clamps below 0 to 0', () => {
      expect(FunZoneClusteringService.clamp01(-5)).toBe(0);
    });
    it('clamps above 1 to 1', () => {
      expect(FunZoneClusteringService.clamp01(2.5)).toBe(1);
    });
    it('passes through values in range', () => {
      expect(FunZoneClusteringService.clamp01(0.42)).toBe(0.42);
    });
    it('treats NaN as 0', () => {
      expect(FunZoneClusteringService.clamp01(Number.NaN)).toBe(0);
    });
  });

  describe('computeCompositeScore', () => {
    it('returns 0 for an empty/zero zone', () => {
      const score = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: 0,
        avg_quality: FUN_ZONE_SCORE_REFERENCES.qualityMin,
        elevation_range_m: 0,
        road_count: 0,
      });
      expect(score).toBe(0);
    });

    it('saturates to 95 (no scenic source) for a max-out zone', () => {
      // With scenic stuck at 0 the maximum reachable score is (1 - 0.05)*100 = 95.
      const score = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: FUN_ZONE_SCORE_REFERENCES.maxCurviness,
        avg_quality: FUN_ZONE_SCORE_REFERENCES.qualityMax,
        elevation_range_m: FUN_ZONE_SCORE_REFERENCES.maxElevationRangeM,
        road_count: FUN_ZONE_SCORE_REFERENCES.maxRoadCount,
      });
      expect(score).toBeCloseTo(95, 2);
    });

    it('reaches a perfect 100 only when scenic is supplied', () => {
      const score = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: FUN_ZONE_SCORE_REFERENCES.maxCurviness,
        avg_quality: FUN_ZONE_SCORE_REFERENCES.qualityMax,
        elevation_range_m: FUN_ZONE_SCORE_REFERENCES.maxElevationRangeM,
        road_count: FUN_ZONE_SCORE_REFERENCES.maxRoadCount,
        scenic_factor: 1,
      });
      expect(score).toBeCloseTo(100, 2);
    });

    it('clamps inputs above the reference values', () => {
      const overshoot = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: 99,
        avg_quality: 99,
        elevation_range_m: 99_999,
        road_count: 99_999,
        scenic_factor: 99,
      });
      expect(overshoot).toBeCloseTo(100, 2);
    });

    it('weights curviness more heavily than quality', () => {
      const curvy = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: FUN_ZONE_SCORE_REFERENCES.maxCurviness,
        avg_quality: FUN_ZONE_SCORE_REFERENCES.qualityMin,
        elevation_range_m: 0,
        road_count: 0,
      });
      const smooth = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: 0,
        avg_quality: FUN_ZONE_SCORE_REFERENCES.qualityMax,
        elevation_range_m: 0,
        road_count: 0,
      });
      expect(curvy).toBeGreaterThan(smooth);
    });

    it('matches the documented weights for a known input', () => {
      // avg_curviness 4 → 0.8, avg_quality 4 → 0.75, elev 750 → 0.5,
      // road_count 15 → 0.5, scenic 0.
      const score = FunZoneClusteringService.computeCompositeScore({
        avg_curviness: 4,
        avg_quality: 4,
        elevation_range_m: 750,
        road_count: 15,
      });
      const expected =
        100 *
        (FUN_ZONE_SCORE_WEIGHTS.curviness * 0.8 +
          FUN_ZONE_SCORE_WEIGHTS.quality * 0.75 +
          FUN_ZONE_SCORE_WEIGHTS.elevation * 0.5 +
          FUN_ZONE_SCORE_WEIGHTS.density * 0.5);
      expect(score).toBeCloseTo(expected, 2);
    });

    it('is monotonic in curviness (boundary check)', () => {
      const baseInput = {
        avg_quality: 3.5,
        elevation_range_m: 500,
        road_count: 10,
      } as const;
      const low = FunZoneClusteringService.computeCompositeScore({
        ...baseInput,
        avg_curviness: 2,
      });
      const mid = FunZoneClusteringService.computeCompositeScore({
        ...baseInput,
        avg_curviness: 3,
      });
      const high = FunZoneClusteringService.computeCompositeScore({
        ...baseInput,
        avg_curviness: 4,
      });
      expect(low).toBeLessThan(mid);
      expect(mid).toBeLessThan(high);
    });

    it('honours an alternate weight bundle', () => {
      const score = FunZoneClusteringService.computeCompositeScore(
        {
          avg_curviness: 5,
          avg_quality: 5,
          elevation_range_m: 0,
          road_count: 0,
        },
        {
          curviness: 1,
          quality: 0,
          elevation: 0,
          density: 0,
          scenic: 0,
        },
      );
      expect(score).toBeCloseTo(100, 2);
    });
  });

  describe('computeContributionScore', () => {
    it('returns 0 for a flat-as-a-pancake segment', () => {
      expect(
        FunZoneClusteringService.computeContributionScore(0, 5, 5000),
      ).toBe(0);
    });

    it('returns 0 when quality is unknown (defaults to floor)', () => {
      expect(
        FunZoneClusteringService.computeContributionScore(5, null, 5000),
      ).toBe(0);
    });

    it('saturates at 1.0 for a max-out segment', () => {
      const score = FunZoneClusteringService.computeContributionScore(
        FUN_ZONE_SCORE_REFERENCES.maxCurviness,
        FUN_ZONE_SCORE_REFERENCES.qualityMax,
        10_000,
      );
      expect(score).toBe(1);
    });

    it('ranks long high-quality curvy roads above short ones', () => {
      const long = FunZoneClusteringService.computeContributionScore(
        4,
        4.5,
        4000,
      );
      const short = FunZoneClusteringService.computeContributionScore(
        4,
        4.5,
        500,
      );
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('deriveBestSeason', () => {
    it('returns year_round when no passes are present', () => {
      expect(FunZoneClusteringService.deriveBestSeason([])).toBe('year_round');
    });

    it('returns summer when any pass closes outside the full year', () => {
      expect(
        FunZoneClusteringService.deriveBestSeason([
          { typical_open_month: 6, typical_close_month: 10 },
        ]),
      ).toBe('summer');
    });

    it('returns year_round when every pass is open year-round', () => {
      expect(
        FunZoneClusteringService.deriveBestSeason([
          { typical_open_month: 1, typical_close_month: 12 },
          { typical_open_month: 1, typical_close_month: 12 },
        ]),
      ).toBe('year_round');
    });

    it('flips to summer at the boundary case (one seasonal pass among year-round ones)', () => {
      expect(
        FunZoneClusteringService.deriveBestSeason([
          { typical_open_month: 1, typical_close_month: 12 },
          { typical_open_month: 7, typical_close_month: 9 },
          { typical_open_month: 1, typical_close_month: 12 },
        ]),
      ).toBe('summer');
    });
  });

  describe('FUN_ZONE_SCORE_WEIGHTS', () => {
    it('weights sum to 1.0', () => {
      const sum =
        FUN_ZONE_SCORE_WEIGHTS.curviness +
        FUN_ZONE_SCORE_WEIGHTS.quality +
        FUN_ZONE_SCORE_WEIGHTS.elevation +
        FUN_ZONE_SCORE_WEIGHTS.density +
        FUN_ZONE_SCORE_WEIGHTS.scenic;
      expect(sum).toBeCloseTo(1, 6);
    });
  });
});
