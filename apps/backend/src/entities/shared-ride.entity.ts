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

@Entity('shared_rides')
@Unique('idx_shared_rides_ride', ['ride_id'])
@Index('idx_shared_rides_token', ['share_token'], { unique: true })
@Index('idx_shared_rides_user', ['user_id'])
export class SharedRide {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ride_id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  share_token: string;

  @Column({ type: 'boolean', default: true })
  is_public: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @ManyToOne(() => Ride, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride: Ride;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
