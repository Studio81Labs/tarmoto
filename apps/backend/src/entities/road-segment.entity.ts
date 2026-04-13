import {
  Entity, PrimaryGeneratedColumn, Column, Index, OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { SurfaceReading } from './surface-reading.entity.js';
import { HazardReport } from './hazard-report.entity.js';
import { RoadReview } from './road-review.entity.js';

@Entity('road_segments')
@Index('idx_road_segments_geom', ['geom'], { spatial: true })
@Index('idx_road_segments_quality', ['quality_score'])
@Index('idx_road_segments_curviness', ['curviness_score'])
export class RoadSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'geometry', spatialFeatureType: 'LineString', srid: 4326 })
  geom: GeoJSON.Geometry;

  @Column({ type: 'float' })
  length_m: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  road_name: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  road_number: string | null;

  @Column({ type: 'float', default: 0 })
  curviness_score: number;

  @Column({ type: 'float', nullable: true })
  quality_score: number | null;

  @Column({ type: 'varchar', length: 30, default: 'unknown' })
  surface_type: string;

  @Column({ type: 'int', default: 0 })
  reading_count: number;

  @Column({ type: 'int', default: 0 })
  confidence: number;

  @Column({ type: 'float', nullable: true })
  elevation_min: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_max: number | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_updated: Date;

  @OneToMany(() => SurfaceReading, (r) => r.road_segment)
  surface_readings: SurfaceReading[];

  @OneToMany(() => HazardReport, (h) => h.road_segment)
  hazard_reports: HazardReport[];

  @OneToMany(() => RoadReview, (r) => r.road_segment)
  road_reviews: RoadReview[];
}
