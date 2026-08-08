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
  GrantPlanSource,
  GrantTier,
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
   *
   * **Treated as a credential, like {@link User.password_hash}: `select: false`
   * AND stripped by the data-export sanitizer.** Its security value is entirely
   * that it is unguessable — anyone holding it can call `Purchases.logIn` with
   * it, which is the attack this column exists to prevent. Leaking it therefore
   * does not merely expose an identifier, it restores the vulnerability. Both
   * guards are deliberate: `select: false` keeps it off incidental reads, and
   * `SECRET_USER_FIELDS` catches the case where something loads it explicitly
   * and then serialises the row.
   */
  @Column({ type: 'uuid', nullable: true, select: false })
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
   * The tier a NON-SUBSCRIPTION grant confers — founder, promo or admin.
   * NULL when the rider has no grant.
   *
   * Separate from {@link subscription_tier} on purpose (#1132). Sharing one
   * column is what forced every Stripe writer to re-derive *"is this tier mine
   * to touch?"*, a predicate that reached three different spellings in one PR
   * and cost six review rounds. Entitlement is `higherTier(grant_tier,
   * subscription_tier)`, so neither side can revoke the other: a grant survives
   * a failed checkout or a terminal clear, and a paid upgrade is not capped by
   * an older grant.
   *
   * Paired with {@link grant_source} and {@link grant_granted_at} by an
   * all-three-or-none CHECK — a tier with no provenance cannot be audited,
   * provenance with no tier entitles nothing, and neither can be placed on a
   * timeline without the timestamp.
   *
   * Typed `GrantTier`, NOT `SubscriptionTier`: the database rejects `free`, so a
   * wider type would let a writer compile and then fail at runtime — most
   * likely a revocation assigning the ordinary free tier. Revocation is clearing
   * all three columns.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  grant_tier!: GrantTier | null;

  /**
   * Where {@link grant_tier} came from: `founder` | `promo` | `admin`.
   *
   * Deliberately never `subscription`, and never NULL while `grant_tier` is set.
   * A NULL `plan_source` means a LEGACY PAID rider (the column shipped without a
   * backfill), not a grant — reading it as one would make those riders
   * un-cancellable.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  grant_source!: GrantPlanSource | null;

  /**
   * When the grant was made. NULL when there is no grant.
   *
   * Not decoration: "when did this rider get premium, and does it predate the
   * incident?" is the first thing support asks, and a grant that cannot answer
   * it cannot be reasoned about.
   */
  @Column({ type: 'timestamptz', nullable: true })
  grant_granted_at!: Date | null;

  /**
   * Monotonic FENCING TOKEN for the per-rider subscription-mutation lock
   * (`SubscriptionMutationLockService`). Each lock acquisition takes a strictly
   * increasing token from the `subscription_lock_fence_seq` SEQUENCE — not Redis
   * `INCR`, as this said before #1138: the counter has to be as durable as the
   * fence it orders, and a Redis restart that lost it would silently reissue
   * tokens already in use. Every guarded subscription-row UPDATE gates on
   * `subscription_lock_fence <= :token`, so a flow whose lease was lost
   * mid-section can never clobber or resurrect a newer flow's state — the newer
   * flow's higher token locks the older one out at the DB. Defaults to 0 (below
   * the first token).
   *
   * Allocated and stamped by the SAME statement that takes
   * {@link subscription_lock_owner}, so there is no interval in which a stalled
   * acquirer could allocate a token out of acquisition order.
   */
  @Column({
    type: 'bigint',
    default: 0,
    // NOT SELECTED — see the shared note on `subscription_lock_owner` below.
    // `save()` diffs a loaded entity against a fresh reload and writes back every
    // differing column, so a default-selected lock column can be resurrected from
    // an unrelated request's stale snapshot. For the FENCE that means moving the
    // high-water mark BACKWARDS, which lets a stale flow's `fence <= :token`
    // guard pass — the precise failure the fence exists to prevent.
    select: false,
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  subscription_lock_fence!: number;

  /**
   * Holder of the per-rider subscription-mutation LEASE — the acquirer's opaque
   * token, the same value used for its Redis lock so both layers name one holder.
   * NULL when unheld.
   *
   * This is what makes the fence ordering sound. Acquisition is one guarded
   * UPDATE that takes the lease AND allocates the fence, so "token order" and
   * "acquisition order" are decided by the same system in the same statement.
   * Before #1138 closed this, acquisition happened in Redis and allocation in
   * PostgreSQL: a holder stalling between them (pool starvation is enough) could
   * outlive its TTL and then stamp a LATER token than its successor, fencing out
   * the live holder rather than merely looking current.
   *
   * Redis remains the cheap contention gate. Correctness lives here.
   *
   * ## Why `select: false` on all three lock columns
   *
   * `save()` diffs a loaded entity against a fresh reload and writes back every
   * column that differs — the same hazard `users.service.ts` documents when it
   * detaches `preferences` before saving. Whole-entity saves elsewhere
   * (`updateProfile`, `uploadAvatar`) load a `User` and save it later, so a
   * default-selected lease column would be persisted from a stale snapshot:
   *
   *  - loaded during a lease, saved after release → RESURRECTS a dead owner and
   *    expiry, rejecting subscription mutations until that expiry lapses;
   *  - loaded before acquisition, saved during a lease → CLEARS the lease and
   *    reopens the Redis-loss handoff race the lease exists to close.
   *
   * `select: false` makes the property `undefined` on load, and `save()` skips
   * undefined properties entirely — so unrelated saves cannot touch these
   * columns, whether or not their author knew the columns existed. Every
   * legitimate reader here uses raw SQL or an explicit `select`.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  subscription_lock_owner!: string | null;

  /**
   * Absolute expiry of the lease in {@link subscription_lock_owner}. NULL when
   * unheld. Renewed by the same heartbeat that renews the Redis lock, and
   * cleared on release so the next acquirer never has to wait out a TTL that
   * nobody is using.
   *
   * Absolute rather than acquired-at so the takeover predicate is a plain
   * `<= now()` PostgreSQL evaluates itself — no clock arithmetic in application
   * code, and no dependence on the app server's clock agreeing with the
   * database's.
   */
  @Column({ type: 'timestamptz', nullable: true, select: false })
  subscription_lock_lease_expires_at!: Date | null;

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
