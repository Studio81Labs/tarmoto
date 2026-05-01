import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { RouteCollection } from './route-collection.entity.js';

/**
 * US-56 — a member of a `RouteCollection`. Items reference EITHER a planner
 * trip or a recorded ride (issue spec: "ride_id-or-trip_id"). The DB enforces
 * "exactly one is set" via a CHECK constraint declared in the migration so the
 * row can't drift into a both-null or both-populated state.
 *
 * `position` is server-assigned monotonic on insert (max+1). Reordering is
 * out of scope for the first slice — the field exists so reorder can ship
 * without a schema change.
 */
@Entity('route_collection_items')
@Index('idx_route_collection_items_collection', ['collection_id', 'position'])
@Index('idx_route_collection_items_trip', ['trip_id'])
@Index('idx_route_collection_items_ride', ['ride_id'])
export class RouteCollectionItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  collection_id!: string;

  @Column({ type: 'uuid', nullable: true })
  trip_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ride_id!: string | null;

  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => RouteCollection, (c) => c.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collection_id' })
  collection!: RouteCollection;
}
