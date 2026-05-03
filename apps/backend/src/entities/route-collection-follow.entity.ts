import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';
import { RouteCollection } from './route-collection.entity.js';

/**
 * US-56 follow/save relationship — pairs a viewer (`user_id`) with a route
 * collection (`collection_id`) so the collection appears in the viewer's
 * library alongside their own collections. The unique constraint makes
 * follow idempotent: a duplicate POST returns the existing row instead of
 * accumulating duplicate join rows.
 *
 * Cascade-deletes from both sides: deleting the user (US-62 hard delete) or
 * the source collection cleans up the follow rows automatically. We do NOT
 * delete on visibility flips — a curator who toggles their collection back
 * to private should not silently lose followers, but the slug stops being
 * dereferenceable so the follow has no UI surface anyway.
 */
@Entity('route_collection_follows')
@Unique('uq_route_collection_follows_user_collection', [
  'user_id',
  'collection_id',
])
@Index('idx_route_collection_follows_user', ['user_id'])
@Index('idx_route_collection_follows_collection', ['collection_id'])
export class RouteCollectionFollow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid' })
  collection_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => RouteCollection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collection_id' })
  collection!: RouteCollection;
}
