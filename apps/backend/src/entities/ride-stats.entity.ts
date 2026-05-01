import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import type { LeanDistribution } from '@tarmoto/shared';
import { Ride } from './ride.entity.js';

@Entity('ride_stats')
export class RideStats {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  ride_id!: string;

  @Column({ type: 'float', nullable: true })
  elevation_gain!: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_loss!: number | null;

  @Column({ type: 'int', nullable: true })
  curve_count!: number | null;

  @Column({ type: 'float', nullable: true })
  fuel_estimate_l!: number | null;

  @Column({ type: 'interval', nullable: true })
  duration!: string | null;

  @Column({ type: 'float', nullable: true })
  avg_lean_angle!: number | null;

  @Column({ type: 'float', nullable: true })
  max_lean_angle!: number | null;

  /**
   * US-19 lean histogram — counts the number of sensor samples that
   * fell into each bucket. The bucket boundaries are owned by
   * `@tarmoto/shared` (`LEAN_BUCKETS`); the column stays as a flexible
   * JSONB so a future change to the buckets is a code-only migration.
   */
  @Column({ type: 'jsonb', nullable: true })
  lean_distribution_json!: LeanDistribution | null;

  @Column({ type: 'int', nullable: true })
  calories_est!: number | null;

  @OneToOne(() => Ride, (r) => r.stats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;
}
