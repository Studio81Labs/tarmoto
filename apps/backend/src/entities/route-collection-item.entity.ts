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
 * US-56 — a member of a `RouteCollection`. Items reference a recorded ride.
 * (Trips are private/collaborator-only and are never surfaced through
 * collections; the historical trip column was dropped in migration
 * `DropTripFromRouteCollections`.)
 *
 * `position` is server-assigned monotonic on insert (max+1). On reorder
 * (PATCH `/collections/:id/items/reorder`) the service renumbers every item
 * 0..N-1 in one transaction under a parent-row write lock so the dense
 * monotonic invariant holds even under concurrent adds.
 */
@Entity('route_collection_items')
@Index('idx_route_collection_items_collection', ['collection_id', 'position'])
@Index('idx_route_collection_items_ride', ['ride_id'])
export class RouteCollectionItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  collection_id!: string;

  @Column({ type: 'uuid' })
  ride_id!: string;

  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => RouteCollection, (c) => c.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collection_id' })
  collection!: RouteCollection;
}
