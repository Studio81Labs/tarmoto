import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import type {
  LocationRetention,
  ProfileVisibility,
  RideSharingDefault,
} from '@tarmoto/shared';
import { User } from './user.entity.js';

/**
 * Per-user privacy preferences (#279). One row per user, keyed by
 * `user_id` (PK). Created lazily — rows only land when a user saves
 * preferences from the companion privacy page; otherwise the canonical
 * defaults from `@tarmoto/shared` are returned at read time.
 *
 * Each toggle has a real enforcement site server-side (see #279 spec):
 * profile visibility on the public profile endpoint, default ride
 * sharing at ride finish, road-data contribution on the sensor upload
 * path, retention via the daily sweeper, and analytics + recommendations
 * via the gating helpers exported by the privacy module.
 */
@Entity('privacy_preferences')
export class PrivacyPreferencesRow {
  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16, default: 'riders-only' })
  profile_visibility!: ProfileVisibility;

  @Column({ type: 'varchar', length: 16, default: 'private' })
  default_ride_sharing!: RideSharingDefault;

  @Column({ type: 'boolean', default: true })
  road_data_contribution!: boolean;

  @Column({ type: 'varchar', length: 16, default: '1year' })
  location_retention!: LocationRetention;

  @Column({ type: 'boolean', default: true })
  analytics_consent!: boolean;

  @Column({ type: 'boolean', default: true })
  personalized_recommendations_consent!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
