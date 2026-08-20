import { ClearLaunchModeOverrides1839000000000 } from './1839000000000-ClearLaunchModeOverrides.js';

describe('ClearLaunchModeOverrides migration', () => {
  function makeQueryRunner() {
    const queries: string[] = [];
    const queryRunner = {
      query: (query: string) => {
        queries.push(query);
        return Promise.resolve();
      },
    } as never;
    return { queryRunner, queries };
  }

  describe('up', () => {
    it('deletes all five seeded force_on feature_states rows', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      expect(queries).toHaveLength(2);
      expect(queries[0]).toMatch(/DELETE FROM feature_states/);
      expect(queries[0]).toMatch(
        /feature IN \(\s*'gpx_export',\s*'commuter_mode',\s*'group_rides',\s*'advanced_ride_stats',\s*'collaborative_trips'\s*\)/,
      );
    });

    it('deletes all four seeded null-override limit_states rows', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      expect(queries[1]).toMatch(/DELETE FROM limit_states/);
      expect(queries[1]).toMatch(
        /feature IN \(\s*'max_active_trips',\s*'max_trip_collaborators',\s*'road_quality_max_zoom',\s*'max_group_ride_members'\s*\)/,
      );
    });

    // Regression guard: `full_road_quality_zoom` / `unlimited_trip_planning`
    // are retired keys whose override rows are deliberately left in place as
    // inert orphans (migration 1814's precedent) — this migration must not
    // widen its DELETE to catch them.
    it('does NOT touch the retired inert keys', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      const combined = queries.join('\n');
      expect(combined).not.toMatch(/full_road_quality_zoom/);
      expect(combined).not.toMatch(/unlimited_trip_planning/);
    });

    it('is a plain DELETE with no existence guard needed — safe to re-run', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);
      await new ClearLaunchModeOverrides1839000000000().up(queryRunner);

      expect(queries).toHaveLength(4);
    });
  });

  describe('down', () => {
    it('re-seeds the five feature_states rows with their original reasons', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().down(queryRunner);

      expect(queries).toHaveLength(2);
      expect(queries[0]).toMatch(/INSERT INTO feature_states/);
      expect(queries[0]).toMatch(/'gpx_export', 'force_on'/);
      expect(queries[0]).toMatch(/'commuter_mode', 'force_on'/);
      expect(queries[0]).toMatch(/'group_rides', 'force_on'/);
      expect(queries[0]).toMatch(/'advanced_ride_stats', 'force_on'/);
      expect(queries[0]).toMatch(/'collaborative_trips', 'force_on'/);
      // The 1819-seeded rows carry their original migration marker.
      expect(queries[0]).toMatch(/'advanced_ride_stats'.*\[seed:1819\]/);
      expect(queries[0]).toMatch(/'collaborative_trips'.*\[seed:1819\]/);
      expect(queries[0]).toMatch(/ON CONFLICT \(feature\) DO NOTHING/);
    });

    it('re-seeds the four limit_states rows with NULL values', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new ClearLaunchModeOverrides1839000000000().down(queryRunner);

      expect(queries[1]).toMatch(/INSERT INTO limit_states/);
      expect(queries[1]).toMatch(/'max_active_trips', NULL/);
      expect(queries[1]).toMatch(/'max_trip_collaborators', NULL/);
      expect(queries[1]).toMatch(/'road_quality_max_zoom', NULL/);
      expect(queries[1]).toMatch(
        /'max_group_ride_members', NULL.*\[seed:1819\]/,
      );
      expect(queries[1]).toMatch(/ON CONFLICT \(feature\) DO NOTHING/);
    });
  });
});
