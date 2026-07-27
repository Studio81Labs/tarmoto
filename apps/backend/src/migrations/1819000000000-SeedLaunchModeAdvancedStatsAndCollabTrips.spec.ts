import { SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000 } from './1819000000000-SeedLaunchModeAdvancedStatsAndCollabTrips.js';

describe('SeedLaunchModeAdvancedStatsAndCollabTrips migration', () => {
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
    it('seeds force_on feature_states rows for both toggles', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000().up(
        queryRunner,
      );

      expect(queries[0]).toMatch(/INSERT INTO feature_states/);
      expect(queries[0]).toMatch(/'advanced_ride_stats', 'force_on'/);
      expect(queries[0]).toMatch(/'collaborative_trips', 'force_on'/);
      // Each seeded reason carries the migration-unique marker so down() can
      // delete only rows this migration wrote.
      expect(queries[0]).toContain('[seed:1819]');
    });

    // Regression guard for the HIGH finding: `group_rides` is already
    // force_on (migration 1795), so a free/pro rider reaches
    // GroupRidesService.join the moment this migration's predecessor ships.
    // Without a NULL limit_states override, `max_group_ride_members`
    // resolves to the tier value 0 and the owner (member #1) already
    // exceeds it, 403-ing the very first non-premium join. This migration
    // must ALSO seed a null (unlimited) override so the join path stays
    // dark like the two feature toggles above.
    it('also seeds a NULL (unlimited) limit_states override for max_group_ride_members', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000().up(
        queryRunner,
      );

      expect(queries).toHaveLength(2);
      expect(queries[1]).toMatch(/INSERT INTO limit_states/);
      expect(queries[1]).toMatch(/'max_group_ride_members', NULL/);
      expect(queries[1]).toMatch(
        /Launch mode: unlimited for everyone until tier enforcement goes live\./,
      );
      expect(queries[1]).toMatch(/ON CONFLICT \(feature\) DO NOTHING/);
    });
  });

  describe('down', () => {
    it('deletes only feature_states rows carrying this migration marker', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000().down(
        queryRunner,
      );

      expect(queries[0]).toMatch(/DELETE FROM feature_states/);
      expect(queries[0]).toMatch(
        /feature IN \('advanced_ride_stats', 'collaborative_trips'\)/,
      );
      expect(queries[0]).toMatch(/state = 'force_on'/);
      // Scoped to the migration marker — NOT a bare reason/state match — so a
      // pre-existing operator override for the same feature survives rollback.
      expect(queries[0]).toMatch(/reason LIKE '%\[seed:1819\]'/);
    });

    it('also deletes only the marked launch-mode limit_states row', async () => {
      const { queryRunner, queries } = makeQueryRunner();

      await new SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000().down(
        queryRunner,
      );

      expect(queries).toHaveLength(2);
      expect(queries[1]).toMatch(/DELETE FROM limit_states/);
      expect(queries[1]).toMatch(/feature = 'max_group_ride_members'/);
      expect(queries[1]).toMatch(/value IS NULL/);
      expect(queries[1]).toMatch(/reason LIKE '%\[seed:1819\]'/);
    });
  });
});
