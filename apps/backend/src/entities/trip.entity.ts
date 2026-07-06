import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';
import { TripMember } from './trip-member.entity.js';
import { TripDay } from './trip-day.entity.js';
import { TripFolder } from './trip-folder.entity.js';

@Entity('trips')
@Index('idx_trips_owner', ['owner_id'])
@Index('idx_trips_folder', ['folder_id'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  /**
   * US-37 — optional rider-owned folder. Nullable so trips without a
   * folder render in the "Unfiled" pseudo-bucket on the client. The FK
   * is `ON DELETE SET NULL` so deleting a folder does NOT cascade into
   * its trips; the trips just become unfiled.
   */
  @Column({ type: 'uuid', nullable: true })
  folder_id!: string | null;

  @ManyToOne(() => TripFolder, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'folder_id' })
  folder!: TripFolder | null;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  region!: string | null;

  @Column({ type: 'int', default: 1 })
  num_days!: number;

  @Column({ type: 'float', default: 150 })
  daily_km_min!: number;

  @Column({ type: 'float', default: 350 })
  daily_km_max!: number;

  @Column({ type: 'float', default: 3.0 })
  min_quality!: number;

  @Column({ type: 'varchar', length: 30, default: 'curvy' })
  road_preference!: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, (u) => u.trips)
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => TripMember, (m) => m.trip)
  members!: TripMember[];

  @OneToMany(() => TripDay, (d) => d.trip)
  days!: TripDay[];

  /**
   * Transient — populated only by `TripsService.list` via TypeORM's
   * `loadRelationCountAndMap`. Not a database column. Lets the list
   * endpoint surface the member count without hydrating every membership
   * row for every trip in the result set.
   */
  member_count?: number;
}
