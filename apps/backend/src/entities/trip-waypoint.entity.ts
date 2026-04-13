import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { TripDay } from './trip-day.entity.js';
import { RoadSegment } from './road-segment.entity.js';

@Entity('trip_waypoints')
@Index('idx_trip_waypoints_day', ['trip_day_id', 'sequence'])
export class TripWaypoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  trip_day_id: string;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  location: GeoJSON.Geometry;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 30, default: 'via' })
  waypoint_type: string;

  @Column({ type: 'uuid', nullable: true })
  road_segment_id: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'int', nullable: true })
  duration_min: number | null;

  @ManyToOne(() => TripDay, (d) => d.waypoints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_day_id' })
  trip_day: TripDay;

  @ManyToOne(() => RoadSegment, { nullable: true })
  @JoinColumn({ name: 'road_segment_id' })
  road_segment: RoadSegment | null;
}
