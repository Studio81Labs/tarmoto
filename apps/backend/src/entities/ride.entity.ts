import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  OneToOne,
  Index,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { User } from './user.entity.js';
import { RideSegment } from './ride-segment.entity.js';
import { RideStats } from './ride-stats.entity.js';
import { Bike } from './bike.entity.js';

@Entity('rides')
@Index('idx_rides_user', ['user_id'])
@Index('idx_rides_geom', ['route_geom'], { spatial: true })
@Index('idx_rides_started', ['started_at'])
export class Ride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'timestamptz' })
  started_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;

  @Column({ type: 'float', nullable: true })
  distance_km!: number | null;

  @Column({ type: 'float', nullable: true })
  avg_speed!: number | null;

  @Column({ type: 'float', nullable: true })
  max_speed!: number | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'LineString',
    srid: 4326,
    nullable: true,
  })
  route_geom!: GeoJSON.Geometry | null;

  @Column({ type: 'float', nullable: true })
  avg_road_quality!: number | null;

  @Column({ type: 'float', nullable: true })
  avg_curviness!: number | null;

  @Column({ type: 'varchar', length: 20, default: 'free' })
  ride_type!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  @Column({ type: 'uuid', nullable: true })
  bike_id!: string | null;

  // ── Idle-baseline calibration (issue #494) ──
  // Captured at ride start: ~30 s of stationary samples whose per-axis
  // mean is subtracted from raw accelerometer readings before the feature
  // pipeline runs (see `apps/mobile/src/services/idleBaselineCalibrator.ts`).
  // Values are uploaded with each `POST /sensor/upload` batch and the
  // backend persists them on the ride exactly once — the mobile client
  // sends the same payload across every batch in a ride, so a
  // first-write-wins UPDATE in `SensorService.processUpload` keeps the
  // bias stable even when an offline-queue replay races a fresh upload.
  // All six values are nullable so legacy rides keep working.

  @Column({ type: 'float', nullable: true })
  calibration_axis_mean_x!: number | null;

  @Column({ type: 'float', nullable: true })
  calibration_axis_mean_y!: number | null;

  @Column({ type: 'float', nullable: true })
  calibration_axis_mean_z!: number | null;

  @Column({ type: 'float', nullable: true })
  calibration_axis_std_x!: number | null;

  @Column({ type: 'float', nullable: true })
  calibration_axis_std_y!: number | null;

  @Column({ type: 'float', nullable: true })
  calibration_axis_std_z!: number | null;

  @Column({ type: 'int', nullable: true })
  calibration_sample_count!: number | null;

  @Column({ type: 'boolean', nullable: true })
  calibration_truncated!: boolean | null;

  /**
   * Server-side classification of the calibration's trustworthiness —
   * `'good'` when every axis std came in under the stationary
   * threshold AND the sample count cleared the floor, `'poor'` when
   * the rider didn't sit still long enough. See
   * `classifyCalibrationQuality` in `@tarmoto/shared`.
   */
  @Column({ type: 'varchar', length: 8, nullable: true })
  calibration_quality!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => User, (u) => u.rides)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Bike, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'bike_id' })
  bike!: Bike | null;

  @OneToMany(() => RideSegment, (rs) => rs.ride)
  segments!: RideSegment[];

  @OneToOne(() => RideStats, (rs) => rs.ride)
  stats!: RideStats | null;
}
