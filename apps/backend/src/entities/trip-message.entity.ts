import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Trip } from './trip.entity.js';
import { User } from './user.entity.js';

/**
 * Lightweight chat message scoped to a trip. Membership is enforced at
 * the service layer; the FK only ties the message to the trip. Pagination
 * is keyset-style on `(trip_id, created_at DESC, id DESC)` so a steady
 * stream of new messages doesn't push old pages off a cursor.
 */
@Entity('trip_messages')
@Index('idx_trip_messages_trip_created', ['trip_id', 'created_at'])
export class TripMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  author!: User;
}
