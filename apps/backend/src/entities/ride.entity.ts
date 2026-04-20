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

  @Column({ type: 'varchar', length: 20, default: 'free' })
  ride_type!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => User, (u) => u.rides)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @OneToMany(() => RideSegment, (rs) => rs.ride)
  segments!: RideSegment[];

  @OneToOne(() => RideStats, (rs) => rs.ride)
  stats!: RideStats | null;
}
