import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Unique,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { Trip } from './trip.entity.js';
import { TripWaypoint } from './trip-waypoint.entity.js';

@Entity('trip_days')
@Unique(['trip_id', 'day_number'])
export class TripDay {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'int' })
  day_number!: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  title!: string | null;

  @Column({ type: 'float', nullable: true })
  distance_km!: number | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'LineString',
    srid: 4326,
    nullable: true,
  })
  route_geom!: GeoJSON.Geometry | null;

  @Column({ type: 'float', nullable: true })
  avg_quality!: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_gain!: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_loss!: number | null;

  @Column({ type: 'float', nullable: true })
  curviness_score!: number | null;

  @Column({ type: 'float', nullable: true })
  scenic_score!: number | null;

  @Column({ type: 'interval', nullable: true })
  estimated_time!: string | null;

  @ManyToOne(() => Trip, (t) => t.days, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @OneToMany(() => TripWaypoint, (w) => w.trip_day)
  waypoints!: TripWaypoint[];
}
