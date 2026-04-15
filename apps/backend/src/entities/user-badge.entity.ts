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

@Entity('user_badges')
@Unique('idx_user_badges_unique', ['user_id', 'badge_key'])
@Index('idx_user_badges_user', ['user_id'])
export class UserBadge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 50 })
  badge_key: string;

  @Column({ type: 'varchar', length: 10 })
  tier: string;

  @CreateDateColumn({ type: 'timestamptz' })
  earned_at: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
