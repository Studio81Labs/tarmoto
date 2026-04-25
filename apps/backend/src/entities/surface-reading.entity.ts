import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { RoadSegment } from './road-segment.entity.js';
import { Ride } from './ride.entity.js';
import { User } from './user.entity.js';

@Entity('surface_readings')
@Index('idx_surface_readings_segment', ['road_segment_id'])
@Index('idx_surface_readings_time', ['recorded_at'])
export class SurfaceReading {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  road_segment_id!: string;

  @Column({ type: 'uuid', nullable: true })
  ride_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  user_id!: string | null;

  @Column({ type: 'float' })
  iri_value!: number;

  @Column({ type: 'varchar', length: 20 })
  classification!: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  surface_type!: string | null;

  @Column({ type: 'float', nullable: true })
  vibration_rms!: number | null;

  @Column({ type: 'float', nullable: true })
  speed_at_reading!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  device_model!: string | null;

  /**
   * Identifier of the on-device TF Lite classifier that produced the
   * window-level labels for the batch this row came from (US-3). Null
   * when the v0 RMS heuristic ran instead (mobile fallback). The
   * aggregator uses this to gate retired classifier output without
   * dropping the row.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  model_version!: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  recorded_at!: Date;

  @ManyToOne(() => RoadSegment, (rs) => rs.surface_readings)
  @JoinColumn({ name: 'road_segment_id' })
  road_segment!: RoadSegment;

  @ManyToOne(() => Ride, { nullable: true })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;
}
