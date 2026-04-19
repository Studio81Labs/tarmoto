import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';
import { TripMember } from './trip-member.entity.js';
import { TripDay } from './trip-day.entity.js';

@Entity('trips')
@Index('idx_trips_owner', ['owner_id'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  region!: string | null;

  @Column({ type: 'int', default: 1 })
  num_days!: number;

  @Column({ type: 'float', default: 150 })
  daily_km_min!: number;

  @Column({ type: 'float', default: 350 })
  daily_km_max!: number;

  @Column({ type: 'float', default: 3.0 })
  min_quality!: number;

  @Column({ type: 'varchar', length: 30, default: 'curvy' })
  road_preference!: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, (u) => u.trips)
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => TripMember, (m) => m.trip)
  members!: TripMember[];

  @OneToMany(() => TripDay, (d) => d.trip)
  days!: TripDay[];
}
