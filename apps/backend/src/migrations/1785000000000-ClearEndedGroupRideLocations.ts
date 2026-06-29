import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #752 — one-time privacy cleanup. Before this change, ending a group
 * ride only set `ended_at`; each member's last-known position and
 * `recent_path` breadcrumb buffer were left in place indefinitely. The
 * service now wipes them on ride end, but rows from rides that ended
 * before this deploy still carry stale location data, so clear them.
 *
 * Active rides (`ended_at IS NULL`) are untouched — their live location
 * is still needed (e.g. the severe-weather sweep). Data-only migration;
 * `down()` is a no-op (deleted location can't be restored).
 */
export class ClearEndedGroupRideLocations1785000000000 implements MigrationInterface {
  name = 'ClearEndedGroupRideLocations1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE group_ride_members m
      SET last_lat = NULL,
          last_lng = NULL,
          last_speed = NULL,
          last_heading = NULL,
          last_position_at = NULL,
          recent_path = '[]'::jsonb
      FROM group_rides g
      WHERE m.group_ride_id = g.id
        AND g.ended_at IS NOT NULL
        AND (
          m.last_lat IS NOT NULL
          OR m.last_lng IS NOT NULL
          OR m.last_speed IS NOT NULL
          OR m.last_heading IS NOT NULL
          OR m.last_position_at IS NOT NULL
          OR m.recent_path <> '[]'::jsonb
        );
    `);
  }

  public async down(): Promise<void> {
    // No-op: cleared location data is not recoverable.
  }
}
