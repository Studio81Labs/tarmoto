import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';
import { GroupRideMember } from './group-ride-member.entity.js';

/**
 * US-26 — collaborative live-location ride.
 *
 * A `group_ride` is a short-lived "session" that one rider creates and
 * others join via a 6-char code. The owner_id is convenience: every
 * owner is also a row in `group_ride_members`, so authorisation reads
 * uniformly off membership rather than splitting between owner-checks
 * and member-checks.
 *
 * `ended_at IS NULL` defines an active session. The unique index on
 * `code` is partial (active rides only) so a freshly ended session can
 * have its code reused — six chars are too few to consume globally.
 */
@Entity('group_rides')
@Index('idx_group_rides_owner', ['owner_id'])
export class GroupRide {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 6 })
  code!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => GroupRideMember, (m) => m.group_ride)
  members!: GroupRideMember[];
}
