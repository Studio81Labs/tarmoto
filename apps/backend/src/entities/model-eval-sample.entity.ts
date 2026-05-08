import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { SurfaceReading } from './surface-reading.entity.js';
import { RoadSegment } from './road-segment.entity.js';
import { Ride } from './ride.entity.js';
import { User } from './user.entity.js';
import { Bike } from './bike.entity.js';

/**
 * One row per sampled `SurfaceReading` that the online ML evaluation
 * pipeline (issue #496) is tracking. The row is created at upload
 * time with the rider's per-segment prediction
 * (`predicted_classification` / `predicted_score`) and is
 * reconciled by a recurring job once the road segment's aggregate
 * confidence reaches the spec §8.3 threshold (≥70, ≥5 readings).
 *
 * The metrics endpoint and the alert gauge read from this table:
 *
 *   - `dangerous_misclassification` is the count over a partial
 *     index used by the <1% spec target (§7.3);
 *   - `aggregate_*` columns are the recency-weighted truth that the
 *     prediction is being graded against (§8.3 step 2).
 */
@Entity('model_eval_samples')
@Index('idx_model_eval_samples_created_at', ['created_at'])
@Index('idx_model_eval_samples_segment', ['road_segment_id'])
export class ModelEvalSample {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  surface_reading_id!: string;

  @Column({ type: 'uuid' })
  road_segment_id!: string;

  @Column({ type: 'uuid', nullable: true })
  ride_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  user_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  bike_id!: string | null;

  /**
   * Identifier of the on-device classifier that produced this
   * sample's prediction (`rsc-v1.1.0`, `rsc-v1.0.0`, ...). Null when
   * the mobile fallback heuristic ran (no bundled model loaded).
   * Every metric is segmented by this column so a v1.1 rollout is
   * comparable to the v1.0 baseline still active on stale clients.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  model_version!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  device_model!: string | null;

  @Column({ type: 'varchar', length: 20 })
  predicted_classification!: string;

  @Column({ type: 'smallint' })
  predicted_score!: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  aggregate_classification!: string | null;

  @Column({ type: 'real', nullable: true })
  aggregate_score!: number | null;

  @Column({ type: 'smallint', nullable: true })
  aggregate_confidence!: number | null;

  @Column({ type: 'int', nullable: true })
  aggregate_reading_count!: number | null;

  /**
   * Cached at reconciliation: the rider predicted Excellent or Good
   * (score ≥4) but the aggregate truth is Poor or Very Poor
   * (score ≤2). This is the spec §7.3 safety metric — the alert
   * fires when the 24h rolling rate exceeds 1.5%.
   */
  @Column({ type: 'boolean', nullable: true })
  dangerous_misclassification!: boolean | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reconciled_at!: Date | null;

  @ManyToOne(() => SurfaceReading, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'surface_reading_id' })
  surface_reading!: SurfaceReading;

  @ManyToOne(() => RoadSegment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'road_segment_id' })
  road_segment!: RoadSegment;

  @ManyToOne(() => Ride, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @ManyToOne(() => Bike, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'bike_id' })
  bike!: Bike | null;
}
