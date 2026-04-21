import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity.js';
import { RoadReview } from './road-review.entity.js';

/**
 * Helpful / not-helpful vote on a road review (US-55).
 *
 * A rider can cast at most one vote per review; the unique constraint on
 * `(user_id, road_review_id)` is what makes the POST endpoint effectively
 * an upsert — resubmitting with the opposite `is_helpful` flips the vote
 * without creating a duplicate row.
 */
@Entity('road_review_votes')
@Index('idx_road_review_votes_review', ['road_review_id'])
@Unique('idx_road_review_votes_unique', ['user_id', 'road_review_id'])
export class RoadReviewVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid' })
  road_review_id!: string;

  @Column({ type: 'boolean' })
  is_helpful!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => RoadReview, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'road_review_id' })
  road_review!: RoadReview;
}
