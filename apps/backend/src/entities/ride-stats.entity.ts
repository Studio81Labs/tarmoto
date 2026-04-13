import {
  Entity, PrimaryGeneratedColumn, Column,
  OneToOne, JoinColumn,
} from 'typeorm';
import { Ride } from './ride.entity.js';

@Entity('ride_stats')
export class RideStats {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  ride_id: string;

  @Column({ type: 'float', nullable: true })
  elevation_gain: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_loss: number | null;

  @Column({ type: 'int', nullable: true })
  curve_count: number | null;

  @Column({ type: 'float', nullable: true })
  fuel_estimate_l: number | null;

  @Column({ type: 'interval', nullable: true })
  duration: string | null;

  @Column({ type: 'float', nullable: true })
  avg_lean_angle: number | null;

  @Column({ type: 'float', nullable: true })
  max_lean_angle: number | null;

  @Column({ type: 'int', nullable: true })
  calories_est: number | null;

  @OneToOne(() => Ride, (r) => r.stats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride: Ride;
}
