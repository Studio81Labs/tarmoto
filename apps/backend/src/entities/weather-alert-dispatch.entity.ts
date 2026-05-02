import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity.js';

/**
 * Audit + cooldown ledger for `weather_alert` pushes fired by the
 * scheduled severe-weather sweep (#333).
 *
 * The sweep runs every ~15 minutes, but a storm cell typically lasts
 * an hour or more. Without a cooldown the same rider would receive
 * the same alert four-plus times during a single weather event. The
 * processor consults this table before dispatching: if a row exists
 * for `(user_id, kind)` newer than the cooldown window, the push is
 * skipped.
 *
 * `kind` matches the existing weather-alert kinds emitted by
 * `WeatherService` (`storm | ice | wind | wet`), so the cooldown is
 * scoped per phenomenon — a rider already alerted about wind can
 * still receive a separate alert when conditions deteriorate to a
 * full storm.
 *
 * Rows are insert-only and dispatched_at is the ledger timestamp.
 * The retention sweep does not currently prune this table — rows are
 * tiny and per-dispatch, so unbounded growth is acceptable for the
 * MVP-2 cadence; a follow-up TTL job can be added if it ever matters.
 */
@Entity('weather_alert_dispatches')
@Index('idx_weather_alert_dispatches_user_kind_time', [
  'user_id',
  'kind',
  'dispatched_at',
])
export class WeatherAlertDispatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'dispatched_at' })
  dispatched_at!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
