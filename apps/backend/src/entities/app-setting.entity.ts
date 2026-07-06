import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Generic operator key/value settings (sibling nexcue/tabletap pattern).
 * Today it backs the launch-mode tier grant (`launch_tier`); absence of a
 * row means the setting is off / at its default. Keys are code-defined by
 * the services that read them — operators change values, not vocabulary.
 */
@Entity('app_settings')
@Index('uq_app_settings_key', ['key'], { unique: true })
export class AppSetting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 256 })
  value!: string;

  /** Admin user id that last changed the setting. */
  @Column({ type: 'uuid', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
