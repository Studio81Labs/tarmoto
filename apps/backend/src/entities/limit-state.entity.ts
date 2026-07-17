import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Global limit override. One row per feature key; absence means the
 * limit resolves normally (tier value + per-user override). The value
 * replaces the tier layer for everyone (`NULL` = unlimited — launch
 * mode); an explicit per-user override still wins when it is MORE
 * restrictive (min). Seeded `('max_active_trips', NULL)` at migration
 * time so tier caps stay dark until monetization goes live.
 */
@Entity('limit_states')
@Index('uq_limit_states_feature', ['feature'], { unique: true })
export class LimitState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  feature!: string;

  @Column({ type: 'integer', nullable: true })
  value!: number | null;

  /** Why the override was set — required on write (any global limit
   * change is user-visible). Stored here, kept out of the audit log. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  /** Admin user id that last set the override. */
  @Column({ type: 'uuid', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
