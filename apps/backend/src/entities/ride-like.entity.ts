import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Ride } from './ride.entity.js';
import { User } from './user.entity.js';

/**
 * A rider "hearting" a shared community ride. One row per (ride, user); the
 * unique constraint makes the like idempotent so a double-tap can't inflate
 * the count. `like_count` on the community feed is a COUNT over this table.
 */
@Entity('ride_likes')
@Unique('idx_ride_likes_ride_user', ['ride_id', 'user_id'])
@Index('idx_ride_likes_ride', ['ride_id'])
export class RideLike {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ride_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => Ride, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
