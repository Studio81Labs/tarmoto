import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { Trip } from './trip.entity.js';
import { TripDay } from './trip-day.entity.js';
import { User } from './user.entity.js';
import { RoadSegment } from './road-segment.entity.js';
import { TripSuggestionVote } from './trip-suggestion-vote.entity.js';

/**
 * A proposal from a trip member to add/change a road segment or route on
 * a trip. Other members vote on it; aggregate tallies drive UI priority.
 * Scope is either the whole trip (`trip_day_id` null) or a specific day.
 */
@Entity('trip_suggestions')
@Index('idx_trip_suggestions_trip', ['trip_id'])
// Partial index: matches the migration's `WHERE trip_day_id IS NOT NULL`
// clause so `migration:generate` doesn't emit a spurious drop/recreate
// that would lose the partial optimisation.
@Index('idx_trip_suggestions_day', ['trip_day_id'], {
  where: '"trip_day_id" IS NOT NULL',
})
@Index('idx_trip_suggestions_trip_status', ['trip_id', 'status'])
export class TripSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  trip_id!: string;

  @Column({ type: 'uuid', nullable: true })
  trip_day_id!: string | null;

  @Column({ type: 'uuid' })
  suggested_by!: string;

  @Column({ type: 'uuid', nullable: true })
  road_segment_id!: string | null;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: GeoJSON.Geometry | null;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip!: Trip;

  @ManyToOne(() => TripDay, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'trip_day_id' })
  trip_day!: TripDay | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'suggested_by' })
  suggester!: User;

  @ManyToOne(() => RoadSegment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'road_segment_id' })
  road_segment!: RoadSegment | null;

  @OneToMany(() => TripSuggestionVote, (v) => v.suggestion)
  votes!: TripSuggestionVote[];

  /**
   * Transient — populated by the service layer with the caller's own
   * vote (`'up'`, `'down'`, or `null`) so the API can render the
   * current member's stance without a follow-up request.
   */
  caller_vote?: 'up' | 'down' | null;

  /**
   * Transient — populated by the service layer with vote tallies from
   * the `trip_suggestion_votes` table so clients don't re-aggregate.
   */
  up_votes?: number;
  down_votes?: number;
}
