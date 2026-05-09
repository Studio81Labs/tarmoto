import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity.js';

/**
 * US-37 — rider-owned folder for organising trips ("Summer 2026 Alps",
 * "Weekend Beskydy"). Folders are flat (no nesting) and per-user; the
 * `folder_id` column on `trips` is nullable so trips without a folder
 * render in an "Unfiled" pseudo-bucket on the client.
 *
 * Manual ordering is persisted via `position` (zero-based, dense within
 * a single user). Reorder PATCH passes the desired position deltas; the
 * service is responsible for keeping the column dense.
 */
@Entity('trip_folders')
@Index('idx_trip_folders_user_position', ['user_id', 'position'])
export class TripFolder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  color!: string | null;

  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
