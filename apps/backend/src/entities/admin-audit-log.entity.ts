import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import type { AdminRole } from './admin-user.entity.js';

@Entity('admin_audit_logs')
@Index('idx_admin_audit_created', ['created_at'])
@Index('idx_admin_audit_actor', ['admin_user_id'])
export class AdminAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  admin_user_id!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  admin_role!: AdminRole | null;

  @Column({ type: 'varchar', length: 64 })
  event_key!: string;

  @Column({ type: 'varchar', length: 16 })
  outcome!: 'allowed' | 'denied';

  @Column({ type: 'varchar', length: 10 })
  method!: string;

  @Column({ type: 'varchar', length: 512 })
  path!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  target_type!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  target_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
