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
import { Challenge } from './challenge.entity.js';

@Entity('challenge_entries')
@Unique('idx_challenge_entries_unique', ['challenge_id', 'user_id'])
@Index('idx_challenge_entries_challenge', ['challenge_id'])
@Index('idx_challenge_entries_user', ['user_id'])
export class ChallengeEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  challenge_id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'float', default: 0 })
  progress: number;

  @Column({ type: 'boolean', default: false })
  completed: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  joined_at: Date;

  @ManyToOne(() => Challenge, (c) => c.entries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'challenge_id' })
  challenge: Challenge;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
