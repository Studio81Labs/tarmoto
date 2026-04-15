import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { ChallengeEntry } from './challenge-entry.entity.js';

@Entity('challenges')
export class Challenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 30 })
  metric: string;

  @Column({ type: 'int' })
  target: number;

  @Column({ type: 'timestamptz' })
  starts_at: Date;

  @Column({ type: 'timestamptz' })
  ends_at: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  reward_badge_key: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @OneToMany(() => ChallengeEntry, (e) => e.challenge)
  entries: ChallengeEntry[];
}
