import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Ride } from './ride.entity.js';
import { RoadSegment } from './road-segment.entity.js';

@Entity('ride_segments')
@Index('idx_ride_segments_ride', ['ride_id'])
export class RideSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ride_id: string;

  @Column({ type: 'uuid', nullable: true })
  road_segment_id: string | null;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'float', nullable: true })
  speed_avg: number | null;

  @Column({ type: 'float', nullable: true })
  speed_max: number | null;

  @Column({ type: 'float', nullable: true })
  lean_angle_max: number | null;

  @Column({ type: 'float', nullable: true })
  quality_reading: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  entered_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  exited_at: Date | null;

  @ManyToOne(() => Ride, (r) => r.segments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ride_id' })
  ride: Ride;

  @ManyToOne(() => RoadSegment, { nullable: true })
  @JoinColumn({ name: 'road_segment_id' })
  road_segment: RoadSegment | null;
}
