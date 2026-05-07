import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Ride } from './ride.entity.js';
import { User } from './user.entity.js';

/**
 * Rider-asserted surface label captured during an active ride
 * (research issue #7). Each row is exactly one tap on the in-ride
 * tagging UI; the upload pipeline preserves these verbatim alongside
 * the normalised join into `surface_readings.rider_surface_label` so
 * future re-labeling / training-set construction can read either
 * resolution.
 */
@Entity('ride_tag_events')
@Index('idx_ride_tag_events_ride_t', ['ride_id', 't'])
@Index('idx_ride_tag_events_user_t', ['user_id', 't'])
export class RideTagEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ride_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  /**
   * Client-side wall-clock at the moment of the tap (ms since epoch).
   * Used by the tag→window join — the join is timestamp-driven, not
   * GPS-driven, because a tap can fire while GPS is reacquiring.
   */
  @Column({ type: 'bigint' })
  t!: string;

  @Column({ type: 'double precision', nullable: true })
  lat!: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng!: number | null;

  /**
   * Raw rider-facing label (`smooth_asphalt`, `rough_asphalt`,
   * `cobblestone`, `gravel`, `dirt`, `pothole`). Stored as the source
   * of truth — `surface_readings.rider_surface_label` /
   * `rider_quality_label` are derived from this column.
   */
  @Column({ type: 'varchar', length: 32 })
  label!: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  created_at!: Date;

  @ManyToOne(() => Ride)
  @JoinColumn({ name: 'ride_id' })
  ride!: Ride;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
