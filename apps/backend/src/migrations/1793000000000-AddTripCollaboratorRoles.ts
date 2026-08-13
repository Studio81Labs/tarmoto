import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collaborator management (People tab):
 *
 * 1. Rename member roles to the product vocabulary — `owner` | `editor` |
 *    `viewer`. Existing `admin` and `member` rows both become `editor` so
 *    nobody silently loses an ability they had (members could already
 *    suggest and vote; demoting them to `viewer` would strip that).
 *    New link/code joins default to `viewer` from now on — promotion is
 *    an explicit owner action.
 *
 * 2. `trip_invites` — the `invited` state of a collaborator (the
 *    `joined` state stays in `trip_members`, which every authorization
 *    check builds on). Until now the invite mail was fire-and-forget:
 *    nothing recorded who was invited, so the roster couldn't show
 *    pending invitees and the join flow couldn't honour the role the
 *    owner picked. One row per (trip, email), carrying a PERSONAL
 *    invite code — the emailed join link uses it instead of the
 *    trip-wide code, so revoking one invite invalidates exactly that
 *    person's link. The row is consumed (deleted) when the invitee
 *    joins and their membership adopts the invite's role.
 */
export class AddTripCollaboratorRoles1793000000000 implements MigrationInterface {
  name = 'AddTripCollaboratorRoles1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE trip_members SET role = 'editor' WHERE role IN ('admin', 'member')
    `);
    await queryRunner.query(`
      ALTER TABLE trip_members ALTER COLUMN role SET DEFAULT 'viewer'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trip_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        invite_code VARCHAR(20) NOT NULL,
        invited_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_trip_invites_trip_email UNIQUE (trip_id, email),
        CONSTRAINT uq_trip_invites_code UNIQUE (invite_code)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_trip_invites_email ON trip_invites (email)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS trip_invites`);
    // Editors map back to plain members; viewers had no pre-migration
    // equivalent, so they become members too (strictly more capable —
    // acceptable for a rollback).
    await queryRunner.query(`
      ALTER TABLE trip_members ALTER COLUMN role SET DEFAULT 'member'
    `);
    await queryRunner.query(`
      UPDATE trip_members SET role = 'member' WHERE role IN ('editor', 'viewer')
    `);
  }
}
