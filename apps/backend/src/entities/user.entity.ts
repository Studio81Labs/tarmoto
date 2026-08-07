import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import type {
  PlanSource,
  SubscriptionProvider,
  SubscriptionTier,
  SupportedLocale,
} from '@tarmoto/shared';
import { UserContact } from './user-contact.entity.js';
import { Ride } from './ride.entity.js';
import { HazardReport } from './hazard-report.entity.js';
import { RoadReview } from './road-review.entity.js';
import { Trip } from './trip.entity.js';
import { CommuteRoute } from './commute-route.entity.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 255, select: false })
  password_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  display_name!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar_url!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', length: 10, default: 'en' })
  language!: SupportedLocale;

  @Column({ type: 'varchar', length: 120, nullable: true })
  home_region!: string | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  home_location!: GeoJSON.Geometry | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  work_location!: GeoJSON.Geometry | null;

  @Column({ type: 'jsonb', default: '{}' })
  preferences!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripe_customer_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripe_subscription_id!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  subscription_provider!: SubscriptionProvider | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  apple_original_transaction_id!: string | null;

  /**
   * RevenueCat's `original_transaction_id` for the rider's Play subscription —
   * "`transaction_id` of the original transaction in the subscription", i.e. the
   * identifier that is STABLE for the subscription's whole lifetime. Deliberately
   * NOT the per-subscription `store_transaction_id` / `transaction_id`, which is
   * the CURRENT period's transaction and advances on every renewal (Google Play
   * order ids carry a `..N` suffix that increments per renewal); binding on that
   * would make `claimForGoogle`'s identity guard reject every renewal after the
   * first. This mirrors {@link User.apple_original_transaction_id} exactly —
   * RevenueCat's `original_transaction_id` for an App Store subscription IS the
   * Apple OTID — so the two store bindings read alike.
   */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  google_original_transaction_id!: string | null;

  /**
   * Opaque, backend-issued identifier the rider's device hands to the purchase
   * system — RevenueCat's `app_user_id`, and the successor to the native path's
   * `appAccountToken` (iOS) / `obfuscatedExternalAccountId` (Android).
   *
   * **Never pass `User.id` here.** Rider ids are public to other authenticated
   * riders via `PublicProfileDto.id`, so a modified client could call
   * `Purchases.logIn(<victim's id>)` and have the provider emit a genuinely
   * AUTHENTIC webhook binding its purchase to the victim's row — no webhook
   * secret needed, and every ingestion guard passes because nothing is forged.
   * The victim's own later purchase then fails the identity guard, and under
   * some provider transfer settings an active subscription can be moved
   * outright. Open item (j) in
   * `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
   *
   * NULL until the rider first starts a purchase — minted lazily rather than
   * backfilled, so a NULL truthfully means "never purchased" and the migration
   * does not write every row of the schema's most contended table during a
   * rolling deploy. Unique among non-NULLs
   * (`uq_users_purchase_account_token`): ingestion maps this value back to a
   * rider, so a duplicate would resolve one token to two accounts.
   *
   * Deliberately NOT named for a vendor. RevenueCat is an ingestion channel,
   * not a provider (`SUBSCRIPTION_PROVIDERS` stays `stripe|apple|google`), and a
   * UUID satisfies both its `app_user_id` and Apple's UUID-typed
   * `appAccountToken` — so a future native path reuses this column instead of
   * renaming it. The Google identity column was renamed twice while unused; the
   * spec cites that as a real carrying cost.
   */
  @Column({ type: 'uuid', nullable: true })
  purchase_account_token!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'free' })
  subscription_tier!: SubscriptionTier;

  /**
   * How the tier was obtained (`founder` = launch-mode auto-grant at
   * registration). Null on rows predating the column or set by Stripe
   * before provenance tracking existed.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  plan_source!: PlanSource | null;

  @Column({ type: 'varchar', length: 20, default: 'canceled' })
  subscription_status!: 'active' | 'trialing' | 'past_due' | 'canceled';

  @Column({ type: 'boolean', default: false })
  subscription_cancel_at_period_end!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  subscription_current_period_end!: Date | null;

  /**
   * Last-observed store (Apple) JWS `signedDate` — a strictly-monotonic
   * optimistic-concurrency ordering value. Apple stamps each issued
   * subscription state, so a later state has a strictly greater `signedDate`;
   * the Apple claim / terminal-clear guards order overlapping validations for
   * the same original transaction id on this column so a stale `active` snapshot
   * cannot resurrect a subscription a concurrent terminal clear already killed.
   * Null on rows that predate the column or have never carried an Apple state.
   */
  @Column({ type: 'timestamptz', nullable: true })
  subscription_store_signed_date!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  billing_trial_used_at!: Date | null;

  /**
   * Monotonic FENCING TOKEN for the per-rider subscription-mutation lock
   * (`SubscriptionMutationLockService`). Each lock acquisition takes a strictly
   * increasing token (Redis `INCR`); every guarded subscription-row UPDATE stamps
   * it here and gates on `subscription_lock_fence <= :token`, so a flow whose
   * TTL-based lease was lost mid-section (Redis partition) can never clobber or
   * resurrect a newer flow's state — the newer flow's higher token locks the
   * older one out at the DB. Defaults to 0 (below the first minted token).
   */
  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  subscription_lock_fence!: number;

  /**
   * Per-rider NOTIFICATION GENERATION. Increments once per subscription
   * transition that enqueues a lifecycle notification (in `AccountService`, under
   * the per-rider lock). Each `subscription.notify` job carries the generation it
   * was created for; the consumer delivers only when this still equals it (and the
   * announced state still holds), so an ABA re-activation gets a distinct
   * generation and the stale earlier job is dropped — while a benign same-state
   * webhook redelivery (no enqueue → no increment) keeps matching. Distinct from
   * `subscription_lock_fence`, which is bumped by EVERY webhook and so can't
   * discriminate notification transitions. Defaults to 0.
   */
  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  subscription_notify_generation!: number;

  @Column({ type: 'timestamptz', nullable: true })
  email_verified_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  password_changed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletion_scheduled_at!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  deletion_reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => UserContact, (c) => c.user)
  contacts!: UserContact[];

  @OneToMany(() => Ride, (r) => r.user)
  rides!: Ride[];

  @OneToMany(() => HazardReport, (h) => h.user)
  hazard_reports!: HazardReport[];

  @OneToMany(() => RoadReview, (r) => r.user)
  road_reviews!: RoadReview[];

  @OneToMany(() => Trip, (t) => t.owner)
  trips!: Trip[];

  @OneToMany(() => CommuteRoute, (c) => c.user)
  commute_routes!: CommuteRoute[];
}
