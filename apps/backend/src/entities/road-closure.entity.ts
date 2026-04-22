import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import * as GeoJSON from 'geojson';

/**
 * A road closure or construction zone affecting a road stretch over a
 * date range (US-40). Operator-entered to start; future sources (OSM,
 * official feeds) populate the same table with a different `source`.
 *
 * `ends_at` is nullable — a null end date means "in effect indefinitely
 * / until further notice", which is the common case for long-running
 * seasonal closures.
 */
export type RoadClosureReason =
  | 'closure'
  | 'roadworks'
  | 'seasonal'
  | 'weather'
  | 'event'
  | 'other';

export type RoadClosureSeverity = 'advisory' | 'partial' | 'full';

export type RoadClosureSource = 'operator' | 'osm' | 'official';

@Entity('road_closures')
@Index('idx_road_closures_geom', ['geom'], { spatial: true })
@Index('idx_road_closures_country', ['country_code'])
@Index('idx_road_closures_window', ['starts_at', 'ends_at'])
export class RoadClosure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'varchar', length: 20 })
  reason!: RoadClosureReason;

  @Column({ type: 'varchar', length: 20 })
  severity!: RoadClosureSeverity;

  @Column({ type: 'geometry', spatialFeatureType: 'LineString', srid: 4326 })
  geom!: GeoJSON.LineString;

  @Column({ type: 'varchar', length: 2 })
  country_code!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  region!: string | null;

  @Column({ type: 'timestamptz' })
  starts_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ends_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'operator' })
  source!: RoadClosureSource;

  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
