import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { User } from './user.entity.js';
import { RoadSegment } from './road-segment.entity.js';

@Entity('hazard_reports')
@Index('idx_hazard_reports_location', ['location'], { spatial: true })
@Index('idx_hazard_reports_active', ['is_active', 'expires_at'])
@Index('idx_hazard_reports_segment', ['road_segment_id'])
// Backs the per-user rolling-24h count in the `hazard_reports_per_day` cap.
// Expired reports are retained (deactivated, not deleted), so without this
// the anti-abuse count would be a growing full-table scan on every submit.
@Index('idx_hazard_reports_user_created', ['user_id', 'created_at'])
export class HazardReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  road_segment_id!: string | null;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  location!: GeoJSON.Geometry;

  @Column({ type: 'varchar', length: 30 })
  hazard_type!: string;

  @Column({ type: 'varchar', length: 10, default: 'medium' })
  severity!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'text', nullable: true })
  photo_url!: string | null;

  @Column({ type: 'int', default: 0 })
  confirmations!: number;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  confirmed_at!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'visible' })
  moderation_status!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  moderation_reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  moderated_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  moderated_at!: Date | null;

  @ManyToOne(() => User, (u) => u.hazard_reports)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => RoadSegment, (rs) => rs.hazard_reports, { nullable: true })
  @JoinColumn({ name: 'road_segment_id' })
  road_segment!: RoadSegment | null;
}
