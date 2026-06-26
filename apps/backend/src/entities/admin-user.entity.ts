import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AdminRole = 'read_only' | 'support' | 'admin' | 'super_admin';
export type AdminUserStatus = 'active' | 'disabled';

@Entity('admin_users')
@Index('uq_admin_users_email', ['email'], { unique: true })
@Index('uq_admin_users_sso', ['sso_provider', 'sso_subject'], {
  unique: true,
  where: 'sso_provider IS NOT NULL AND sso_subject IS NOT NULL',
})
@Index('idx_admin_users_role_status', ['role', 'status'])
export class AdminUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  // Null = SSO-only account (password login disabled). select:false so it
  // never leaks through a default find().
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  password_hash!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'read_only' })
  role!: AdminRole;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: AdminUserStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  sso_provider!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sso_subject!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
