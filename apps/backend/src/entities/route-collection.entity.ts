import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';
import { RouteCollectionItem } from './route-collection-item.entity.js';

export type RouteCollectionVisibility = 'private' | 'unlisted' | 'public';

/**
 * US-56 — curated grouping of trips/rides that syncs across devices and can
 * be shared via a stable slug for `public` and `unlisted` visibilities.
 *
 * Visibility semantics:
 *  - `private`  — owner-only; slug exists but isn't dereferenceable.
 *  - `unlisted` — anyone with the slug URL can view; not surfaced in any list.
 *  - `public`   — anyone can view; surfaced wherever public collections appear.
 *
 * The slug is allocated at create time (not at first share) so promoting a
 * private collection to unlisted/public doesn't change the URL — riders can
 * pre-share a link before flipping visibility.
 */
@Entity('route_collections')
@Index('idx_route_collections_owner', ['owner_id'])
@Index('idx_route_collections_slug', ['slug'], { unique: true })
@Index('idx_route_collections_visibility', ['visibility'])
export class RouteCollection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'varchar', length: 80 })
  title!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'private',
  })
  visibility!: RouteCollectionVisibility;

  @Column({ type: 'varchar', length: 24, unique: true })
  slug!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => RouteCollectionItem, (item) => item.collection)
  items!: RouteCollectionItem[];
}
