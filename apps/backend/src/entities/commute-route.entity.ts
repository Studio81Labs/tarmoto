import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { User } from './user.entity.js';

@Entity('commute_routes')
@Index('idx_commute_routes_user', ['user_id'])
export class CommuteRoute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 100, default: 'Default' })
  name: string;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  origin: GeoJSON.Geometry;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  destination: GeoJSON.Geometry;

  @Column({ type: 'geometry', spatialFeatureType: 'LineString', srid: 4326, nullable: true })
  route_geom: GeoJSON.Geometry | null;

  @Column({ type: 'float', nullable: true })
  distance_km: number | null;

  @Column({ type: 'interval', nullable: true })
  avg_duration: string | null;

  @Column({ type: 'float', nullable: true })
  avg_quality: number | null;

  @Column({ type: 'boolean', default: true })
  is_primary: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @ManyToOne(() => User, (u) => u.commute_routes)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
