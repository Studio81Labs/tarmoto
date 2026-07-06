import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { GlobalFeatureState } from '@tarmoto/shared';

/**
 * Global feature override — the operator kill switch / force-on clamp.
 * One row per feature key; absence of a row means the feature resolves
 * normally (registry default + tier grant + per-user override).
 * `force_off` disables the feature for everyone regardless of tier or
 * override; `force_on` enables it for everyone except users with an
 * explicit per-user force-off.
 */
@Entity('feature_states')
@Index('uq_feature_states_feature', ['feature'], { unique: true })
export class FeatureState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  feature!: string;

  @Column({ type: 'varchar', length: 16 })
  state!: GlobalFeatureState;

  /**
   * Why the override was set — required for `force_off` so an incident
   * kill switch always carries context. Deliberately kept out of the
   * admin audit log payload (free-form text may contain user details);
   * this row is its durable record.
   */
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
