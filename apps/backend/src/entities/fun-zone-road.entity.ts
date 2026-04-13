import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { FunZone } from './fun-zone.entity.js';
import { RoadSegment } from './road-segment.entity.js';

@Entity('fun_zone_roads')
@Unique(['fun_zone_id', 'road_segment_id'])
export class FunZoneRoad {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fun_zone_id: string;

  @Column({ type: 'uuid' })
  road_segment_id: string;

  @Column({ type: 'float', nullable: true })
  contribution_score: number | null;

  @ManyToOne(() => FunZone, (fz) => fz.roads, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'fun_zone_id' })
  fun_zone: FunZone;

  @ManyToOne(() => RoadSegment)
  @JoinColumn({ name: 'road_segment_id' })
  road_segment: RoadSegment;
}
