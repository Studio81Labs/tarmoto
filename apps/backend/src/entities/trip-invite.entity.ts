import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Trip } from './trip.entity.js';
import { User } from './user.entity.js';

/**
 * The `invited` state of a trip collaborator (the `joined` state lives
 * in `trip_members`, which authorization builds on). Created by
 * `POST /trips/:tripId/invite`, listed in the roster's PENDING section,
 * and consumed (deleted) when a user with a matching email — or bearing
 * this row's personal `invite_code` — joins the trip; their membership
 * adopts the invite's role instead of the link-join default (`viewer`).
 *
 * The personal code goes into the invite mail's join URL, so revoking
 * a single invite invalidates exactly that recipient's link (unlike the
 * trip-wide code, which is shared and static).
 *
 * Emails are stored lowercased (the invite DTO normalises), one pending
 * invite per (trip, email) — re-inviting the same address updates the
 * role and rotates the code rather than stacking rows.
 */
@Entity('trip_invites')
@Unique('uq_trip_invites_trip_email', ['trip_id', 'email'])
@Unique('uq_trip_invites_code', ['invite_code'])
export class TripInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 20, default: 'viewer' })
  role!: string;

  @Column({ type: 'varchar', length: 20 })
  invite_code!: string;

  @Column({ type: 'uuid', nullable: true })
  invited_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by' })
  inviter!: User | null;
}
