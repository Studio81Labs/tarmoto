import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Trip } from './trip.entity.js';
import { User } from './user.entity.js';

/**
 * Lightweight chat message scoped to a trip. Membership is enforced at
 * the service layer; the FK only ties the message to the trip. Pagination
 * is keyset-style on `(trip_id, created_at DESC, id DESC)` so a steady
 * stream of new messages doesn't push old pages off a cursor.
 *
 * The composite `(trip_id, created_at DESC, id DESC)` index lives in
 * the migration `1715000000000-AddTripCollaboration` — TypeORM's
 * `@Index` decorator can't express per-column sort direction, so
 * declaring it here would cause `migration:generate` to emit spurious
 * drop/recreate statements that regress the optimisation.
 */
@Entity('trip_messages')
export class TripMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 16, default: 'visible' })
  moderation_status!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  moderation_reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  moderated_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  moderated_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  author!: User;
}
