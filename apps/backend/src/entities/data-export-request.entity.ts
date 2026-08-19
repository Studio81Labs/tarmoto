import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity.js';

export type DataExportStatus =
  'queued' | 'processing' | 'ready' | 'failed' | 'expired';

@Entity('data_export_requests')
@Index('idx_data_export_requests_user_status', ['user_id', 'status'])
export class DataExportRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index('idx_data_export_requests_user')
  user_id!: string;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: DataExportStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  storage_key!: string | null;

  @Column({ type: 'bigint', nullable: true })
  byte_size!: string | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
