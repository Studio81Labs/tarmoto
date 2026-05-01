import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { GroupRide } from './group-ride.entity.js';
import { User } from './user.entity.js';

/**
 * Membership in a group ride. The unique index on
 * `(group_ride_id, user_id)` enforces "one slot per rider per ride";
 * leaving deletes the row outright (privacy: AC says positions must
 * disappear immediately on leave) so a re-join is just a fresh insert.
 *
 * The `last_*` columns hold the most recent broadcast position so a
 * `GET /group-rides/:id` request after a brief disconnect can surface
 * known dots without waiting for the next 1 Hz tick. `recent_path` is
 * a capped JSONB ring buffer of the last few positions — populated on
 * every position broadcast and trimmed in the service so old breadcrumbs
 * don't grow unbounded for a long ride.
 */
@Entity('group_ride_members')
@Unique('uq_group_ride_members_member', ['group_ride_id', 'user_id'])
export class GroupRideMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  group_ride_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  joined_at!: Date;

  @Column({ type: 'double precision', nullable: true })
  last_lat!: number | null;

  @Column({ type: 'double precision', nullable: true })
  last_lng!: number | null;

  @Column({ type: 'double precision', nullable: true })
  last_speed!: number | null;

  @Column({ type: 'double precision', nullable: true })
  last_heading!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_position_at!: Date | null;

  @Column({
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  recent_path!: Array<{ lat: number; lng: number; at: string }>;

  @ManyToOne(() => GroupRide, (g) => g.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_ride_id' })
  group_ride!: GroupRide;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
