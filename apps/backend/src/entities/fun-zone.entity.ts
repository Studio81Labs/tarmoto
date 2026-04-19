import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { FunZoneRoad } from './fun-zone-road.entity.js';

@Entity('fun_zones')
@Index('idx_fun_zones_boundary', ['boundary'], { spatial: true })
@Index('idx_fun_zones_score', ['composite_score'])
export class FunZone {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
  boundary!: GeoJSON.Geometry;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name!: string | null;

  @Column({ type: 'float' })
  composite_score!: number;

  @Column({ type: 'int' })
  road_count!: number;

  @Column({ type: 'float', nullable: true })
  total_curve_km!: number | null;

  @Column({ type: 'float', nullable: true })
  avg_quality!: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  best_season!: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_calculated!: Date;

  @OneToMany(() => FunZoneRoad, (r) => r.fun_zone)
  roads!: FunZoneRoad[];
}
