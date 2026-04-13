import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity.js';
import { RoadSegment } from './road-segment.entity.js';

@Entity('road_reviews')
@Index('idx_road_reviews_segment', ['road_segment_id'])
@Unique('idx_road_reviews_unique', ['user_id', 'road_segment_id'])
export class RoadReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'uuid' })
  road_segment_id: string;

  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  bike_model: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  photos: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @ManyToOne(() => User, (u) => u.road_reviews)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => RoadSegment, (rs) => rs.road_reviews)
  @JoinColumn({ name: 'road_segment_id' })
  road_segment: RoadSegment;
}
