import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs/jobs.constants.js';
import { DEFAULT_JOB_OPTIONS } from '../jobs/jobs.config.js';
import type { SubscriptionNotifyJob } from './subscription-notification.service.js';
import { EntityManager, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import {
  formatSubscriptionPriceLabel,
  INTRO_TRIAL_DAYS,
  managedByForProvider,
  SUBSCRIPTION_TIERS,
  type PlanSource,
  higherTier,
  type StoreTier,
} from '@tarmoto/shared';
import { User } from '../../entities/user.entity.js';
import { StoreSubscription } from '../../entities/store-subscription.entity.js';
import { resolveEntitledTier, type StoreRollup } from './entitlement.js';
import { electRepresentative } from './billing-representative.js';
import { getCompanionUrl } from '../../common/companion-url.js';
import {
  isEntitlingStripeStatus,
  STRIPE_BILLING_CLIENT,
  type StripeCheckoutSession,
  type StripeSubscription,
  type BillingStatus,
  type BillingTier,
  type StripeBillingClient,
  type StripeBillingSnapshot,
} from './stripe-billing.client.js';
import {
  ProviderClaimService,
  assertSubscriptionFenceCurrent,
} from './provider-claim.service.js';
import { StoreReconciliationService } from './store-reconciliation.service.js';
import { StoreChainWriterService } from './store-chain-writer.service.js';
import {
  LIVE_CHAIN_SQL,
  liveChainParams,
  overlapFallbackWindowMs,
} from './store-chain-liveness.js';
import {
  SubscriptionMutationLockService,
  type SubscriptionLockLease,
} from './subscription-mutation-lock.service.js';
import type { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto.js';
import type { CreatePortalSessionDto } from './dto/create-portal-session.dto.js';
import type {
  VerifyCheckoutSessionDto,
  VerifyCheckoutSessionResponseDto,
} from './dto/verify-checkout-session.dto.js';
import type {
  RedirectUrlResponseDto,
  SubscriptionSnapshotResponseDto,
} from './dto/subscription-response.dto.js';
import { PurchaseIdentityResponseDto } from './dto/purchase-identity-response.dto.js';
import { firstReturnedRow } from './provider-claim.service.js';
import {
  TRIAL_ELIGIBLE_PREDICATE,
  trialMarkerStamp,
} from './trial-consumption.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

type UserUpdate = Parameters<Repository<User>['update']>[1];

// Shape of the fresh, post-claim re-read both the normal activation-transition
// lost-guard handler and the resubscription-reclaim lost-guard handler consult
// to decide whether a 0-row trialing grant lost SOLELY because
// `billing_trial_used_at` was already set (see `isIneligibleTrialRejection`).
type TrialGuardRow = Pick<
  User,
  | 'subscription_status'
  | 'subscription_provider'
  | 'stripe_subscription_id'
  | 'billing_trial_used_at'
>;

// Billing-email variables stay server-owned; client-facing subscription copy
// is derived from the stable tier in each surface's locale catalog.
const BILLING_PLAN_META: Record<
  BillingTier,
  { name: string; priceLabel: string }
> = {
  free: { name: 'Free', priceLabel: formatSubscriptionPriceLabel('free') },
  pro: { name: 'Pro', priceLabel: formatSubscriptionPriceLabel('pro') },
  premium: {
    name: 'Premium',
    priceLabel: formatSubscriptionPriceLabel('premium'),
  },
};

/**
 * `plan_source` values whose paid tier did NOT come from a Stripe subscription:
 * a launch (`founder`), campaign (`promo`) or operator (`admin`) grant. Those
 * riders hold a paid tier with no billed subscription behind it, so a Stripe
 * subscription that never entitled anything must leave their grant alone.
 *
 * NULL IS DELIBERATELY ABSENT. `PLAN_SOURCES` documents null as "rows
 * predating the column (indistinguishable from `subscription`)", so a null
 * row must be treated as BILLED and dropped to `free` — treating it as a
 * grant would re-open finding 5a for every legacy row.
 */
const NON_SUBSCRIPTION_PLAN_SOURCES: ReadonlySet<PlanSource> = new Set([
  'founder',
  'promo',
  'admin',
]);

function isNonSubscriptionGrant(planSource: PlanSource | null): boolean {
  return planSource != null && NON_SUBSCRIPTION_PLAN_SOURCES.has(planSource);
}

/**
 * RAW Stripe statuses that mean the subscription is OVER — the slot must be
 * released so a later Apple/Google claim can take it.
 *
 * Deliberately narrower than "non-entitling": `unpaid`, `incomplete` and
 * `paused` are non-entitling (a BILLED subscription's tier drops to `free` via
 * `isEntitlingStripeStatus`) but the rider can still recover, so Stripe
 * correctly keeps owning the slot. Releasing it for those would let another
 * provider claim a slot Stripe may yet reactivate.
 */
const TERMINAL_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * RAW Stripe statuses that mean the subscription has NEVER entitled the rider:
 * its very first invoice was never paid, so a trial attached to it (a backdated
 * / zero-day `trial_end`, or a trial whose setup payment failed) was aborted
 * before it could deliver anything. Used ONLY to suppress the once-per-rider
 * trial stamp — burning a rider's single intro trial on a checkout that never
 * took effect would be a silent, unrecoverable downgrade.
 *
 * Deliberately a BLOCKLIST, the inverse of `isEntitlingStripeStatus`'s
 * allowlist, because the two fail in OPPOSITE directions. Wrongly granting
 * entitlement gives away paid features, so entitlement defaults to "no"; wrongly
 * skipping the trial stamp leaves the rider `trial_eligible` and hands them a
 * SECOND free trial, so the stamp defaults to "yes". A status Stripe adds later
 * therefore must not entitle, but must still consume the trial.
 *
 * `unpaid` and `paused` are deliberately ABSENT: both are reached only AFTER a
 * trial ran to its end (a failed post-trial payment, or `trial_settings
 * .end_behavior.missing_payment_method='pause'`), so that trial WAS consumed.
 * `incomplete_expired` is unreachable at the stamp sites today — it is terminal,
 * so `isDeleted` returns first — but it belongs to this invariant, which
 * describes the statuses themselves rather than the current control flow.
 */
const NEVER_ENTITLED_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  'incomplete',
  'incomplete_expired',
]);

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(StoreSubscription)
    private readonly chainRepo: Repository<StoreSubscription>,
    @Inject(STRIPE_BILLING_CLIENT)
    private readonly stripe: StripeBillingClient,
    private readonly config: ConfigService,
    private readonly providerClaim: ProviderClaimService,
    private readonly storeReconciliation: StoreReconciliationService,
    // The overlap machinery's sync (provisional pair creation + retirement),
    // called at every Stripe settle point so a Stripe-side change is judged
    // against the rider's chains with the same `futureBilling` predicate the
    // chain writers use. A no-op for chainless riders — every rider until the
    // step-5 consumer ships.
    private readonly storeChainWriter: StoreChainWriterService,
    private readonly subscriptionLock: SubscriptionMutationLockService,
    // Subscription lifecycle notifications (confirmation/cancellation email,
    // billing-failed push) are DECIDED here under the lock but ENQUEUED for
    // out-of-lock delivery (the consumer revalidates the fence before sending),
    // so a stale send can't outlive a newer event and the ~10s send never risks
    // Stripe's webhook timeout.
    @InjectQueue(QUEUE_NAMES.SUBSCRIPTION_NOTIFY)
    private readonly notifyQueue: Queue,
    private readonly featureResolver: FeatureResolver,
  ) {}

  /**
   * Enqueue a subscription notification for durable, fence-revalidated delivery
   * (see {@link SubscriptionNotifyJob}). Awaited so the job is durably enqueued
   * under the lock (its fence is already stamped), but a Redis hiccup only
   * downgrades to a lost best-effort notification — never fails the committed
   * subscription mutation.
   */
  /**
   * Atomically bump the rider's per-transition NOTIFICATION GENERATION and return
   * the new value, to stamp on the notification job about to be enqueued. Called
   * under the per-rider lock (after `lease.assertHeld()`), so the increment is
   * serialized; the consumer delivers a job only while the row's generation still
   * equals the stamped value, so an ABA re-activation (a fresh bump) drops the
   * stale earlier job while a benign same-state redelivery (no enqueue → no bump)
   * keeps matching.
   */
  private async nextNotifyGeneration(
    userId: string,
    manager: EntityManager,
    fenceToken: number,
  ): Promise<number> {
    // FENCE-GUARDED like every other guarded write: if this UPDATE waited for a
    // pool connection until our Redis lease lapsed and a newer holder (higher
    // fence) committed + enqueued first, `subscription_lock_fence <= :fence` now
    // matches 0 rows. Minting a generation anyway would stamp the OLDER
    // transition as the NEWEST — the worker would then drop the real latest job
    // and deliver this stale one. A 0-row result is that lost-lease case: abort
    // retryable so the flow re-drives under a fresh lease.
    const result: unknown = await manager.query(
      `UPDATE users
          SET subscription_notify_generation = subscription_notify_generation + 1
        WHERE id = $1 AND subscription_lock_fence <= $2
        RETURNING subscription_notify_generation`,
      [userId, fenceToken],
    );
    // node-postgres via TypeORM returns `[returnedRows, affectedCount]` for an
    // UPDATE ... RETURNING (same tuple shape the lock unwraps for
    // its affected count) — the RETURNING rows are the FIRST element, not the
    // tuple itself. Reading the tuple as the row array would make rows[0] an array
    // and yield generation 0, dropping every notification.
    const returnedRows: unknown = Array.isArray(result) ? result[0] : undefined;
    const rows = Array.isArray(returnedRows)
      ? (returnedRows as Array<{
          subscription_notify_generation: string | number;
        }>)
      : [];
    if (rows.length === 0) {
      throw new ServiceUnavailableException({
        message: 'Subscription service is busy. Please retry shortly.',
        retryable: true,
      });
    }
    return Number(rows[0]?.subscription_notify_generation ?? 0);
  }

  /**
   * Enqueue a subscription notification. A failed enqueue is logged and
   * swallowed rather than failing the webhook.
   *
   * RESIDUAL (accepted): the transition + generation increment have already
   * committed by here, so a swallowed enqueue loses that one notification (Stripe
   * acks and won't redeliver; a redelivery wouldn't re-win the transition
   * predicate). Fully closing this needs a transactional outbox (persist the
   * intent atomically with the transition, relay to the queue with retry) — a
   * disproportionate addition here. The exposure is minimal: this enqueue targets
   * the SAME Redis the per-rider lock just succeeded against
   * milliseconds earlier, so a failure means Redis died in that tiny window; and
   * the loss is a missed email/push only — the subscription STATE is correct, so
   * it's a low-harm degradation, not a billing error. Failing the webhook instead
   * would NOT help (the retry can't re-win the already-committed transition), so
   * swallowing is the correct trade here.
   */
  private async enqueueSubscriptionNotification(
    job: SubscriptionNotifyJob,
  ): Promise<void> {
    try {
      await this.notifyQueue.add(
        JOB_NAMES.SUBSCRIPTION_NOTIFY_SEND,
        job,
        DEFAULT_JOB_OPTIONS,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue subscription '${job.kind}' notification for user ${job.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Returns the rider's opaque purchase-account token, minting one on first
   * request.
   *
   * The client passes this to the purchase SDK instead of the Tarmoto user id —
   * rider ids are public to other authenticated riders (`PublicProfileDto.id`),
   * so a user-id-derived app user id would let a modified client bind its
   * purchase to a victim's account with a genuinely authentic webhook. Open item
   * (j) in `docs/superpowers/specs/2026-08-06-mobile-iap-revenuecat-design.md`.
   *
   * MINT-ON-READ, in ONE statement. `COALESCE` makes this race-safe without a
   * lock: two concurrent first requests both run the same UPDATE, the row-level
   * lock serialises them, the loser sees the winner's committed value and
   * returns it. A read-then-write pair would let both mint and one overwrite the
   * other — which matters more than it looks, because a token that changes after
   * a purchase has been made under the old one orphans that purchase.
   */
  async getPurchaseIdentity(
    userId: string,
  ): Promise<PurchaseIdentityResponseDto> {
    const result: unknown = await this.userRepo.query(
      `UPDATE users
          SET purchase_account_token = COALESCE(purchase_account_token, $1)
        WHERE id = $2 AND deleted_at IS NULL
    RETURNING purchase_account_token`,
      [randomUUID(), userId],
    );

    // `UPDATE ... RETURNING` comes back as `[rows, affectedCount]`, not `rows` —
    // see {@link firstReturnedRow}. Reading `result[0].purchase_account_token`
    // directly yields `undefined` and turns every call into a 404.
    const token = firstReturnedRow<{ purchase_account_token: string }>(
      result,
    )?.purchase_account_token;
    if (!token) {
      // Zero rows means the rider is gone OR soft-deleted. `deleted_at IS NULL`
      // is part of the same atomic statement rather than a pre-check, matching
      // `AccountDeletionService`'s own `{ id, deleted_at: IsNull() }` guard:
      // `AuthGuard` rejects a soft-deleted account, but deletion can commit
      // between that check and this write, and a locked-out rider must not be
      // able to mint a token and bind a fresh purchase — the deletion workflow
      // does not yet cancel store subscriptions (#1140), so that purchase would
      // keep billing an account nobody can reach.
      throw new NotFoundException('User not found');
    }

    return { purchase_account_token: token };
  }

  async getSubscription(
    userId: string,
  ): Promise<SubscriptionSnapshotResponseDto> {
    const user = await this.getUserById(userId);
    return this.getSubscriptionSnapshotForUser(user);
  }

  /**
   * Builds the subscription snapshot for an ALREADY-LOADED `User` row, rather
   * than re-reading it by id. Callers that must make an entitling decision and
   * then return a snapshot reflecting THAT SAME decision — a store-ingestion
   * flow answering with the state its own claim or terminal clear just settled
   * on, say — load the row once and pass it here. A separate re-read would
   * reopen a window for a concurrent terminal clear to land between the
   * decision and the read, letting a free/canceled snapshot be returned as a
   * success. Callers with no such decision to reflect should use
   * {@link getSubscription}, which does the read for them.
   */
  async getSubscriptionSnapshotForUser(
    user: User,
  ): Promise<SubscriptionSnapshotResponseDto> {
    // Live Stripe reads are Stripe-owned-row behavior only: a row explicitly
    // claimed by a store provider ('apple'/'google') is never queried against
    // Stripe. A null `subscription_provider` with a stripe_customer_id is a
    // legacy row from before the column existed and still gets the live read.
    // Decided from STRIPE-SIDE EVIDENCE, not the single-valued provider slot.
    // A rider holding both sides reads `apple` or `google` there while Stripe is
    // still billing them, so gating the fetch on the slot left `livePlan` null —
    // which silently removed Stripe from the election and reported them as
    // store-managed with no payment method and no invoices, while Stripe went on
    // charging. This is the third layer of that same slot assumption: the
    // advertised flag, then the portal endpoint, now the read that feeds both.
    //
    // Unchanged where the slot was still right: a store rider whose only Stripe
    // trace is a lingering customer id has no subscription id, so no call is
    // made for them, and a legacy row (null provider with a customer id) still
    // gets its live read.
    const hasStripeSide =
      user.stripe_customer_id != null &&
      (user.stripe_subscription_id != null ||
        user.subscription_provider === 'stripe' ||
        user.subscription_provider == null);
    const liveSnapshot =
      hasStripeSide && user.stripe_customer_id != null
        ? await this.stripe.getBillingSnapshot({
            customerId: user.stripe_customer_id,
            subscriptionId: user.stripe_subscription_id,
          })
        : null;

    // ONE read, and deliberately the CHAINS rather than the cached rollup.
    //
    // Two independent statements could straddle a concurrent claim commit and
    // combine pre- and post-claim state: a Free tier managed by an active store
    // source, or a paid tier with the legacy canceled status and no manager.
    // Reading one source removes the window rather than widening the lock.
    //
    // It is also more accurate here. The rollup is a single max-tier value with
    // an expiry, so mid-rollover — a Premium chain lapsed, a Pro chain still
    // renewing — it reports nothing until recomputation runs. The chains say
    // what is actually live, and this method already has them. The rollup
    // exists for the SYNCHRONOUS resolver's 13 call sites, which cannot query;
    // this one can.
    const chains = await this.loadLiveChains(user.id);
    return this.buildSubscriptionSnapshot(user, liveSnapshot, chains);
  }

  /**
   * The rider's chains that still entitle, newest period first.
   *
   * Liveness is decided the same way `current_period_end` decides it everywhere
   * else — a status allowlist would revoke a rider the instant they cancel,
   * from a period they already paid for. A null end means "no known end" and is
   * kept, matching the resolver rather than silently dropping a paying rider
   * from their own billing screen.
   */
  private async loadLiveChains(userId: string): Promise<StoreSubscription[]> {
    // A rider who changes base plan repeatedly accumulates one row per chain and
    // nothing prunes them, so filtering in JavaScript would make this request's
    // latency and memory scale with their lifetime purchase history. The
    // predicate belongs where the rows are.
    //
    // `LIVE_CHAIN_SQL` is the ONE spelling of chain liveness (a null period end
    // is bounded by the same last-observed + fallback window the rollup and
    // `futureBilling` use), so the snapshot, the resolver, the chain writers
    // and the recomputation worker all stop honouring a silent chain at the
    // same moment.
    return this.chainRepo
      .createQueryBuilder('chain')
      .where('chain.user_id = :userId', { userId })
      .andWhere(
        LIVE_CHAIN_SQL('chain'),
        liveChainParams(new Date(), this.overlapFallbackMs()),
      )
      .getMany();
  }

  /** The bounded null-period window — the ONE reading, owned by `store-chain-liveness.ts`. */
  private overlapFallbackMs(): number {
    return overlapFallbackWindowMs(this.config);
  }

  async createCheckoutSession(
    userId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    // Operator kill switch, checked FIRST so a disable takes effect before any
    // Stripe call. Gates NEW subscriptions only — the billing portal is
    // deliberately NOT gated, so existing subscribers can still manage or
    // cancel while new checkout is stopped. Trapping paying riders in a
    // subscription they cannot cancel would be a worse failure than the one
    // this switch exists to contain.
    if (
      !(await this.featureResolver.isSystemSwitchEnabled(
        'sys_billing_checkout',
      ))
    ) {
      throw new ServiceUnavailableException(
        'Subscriptions are temporarily unavailable. Please try again later.',
      );
    }
    const user = await this.getUserById(userId);
    // A store provider (Apple/Google) OWNS the subscription slot regardless of
    // the current tier. During a Play hold/pause the tier can transiently read
    // `free`/`canceled` while the store still owns billing — creating a Stripe
    // subscription here would double-bill. The provider gate (not just the
    // paid-plan check below, which only inspects tier/status) blocks that.
    if (
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google'
    ) {
      throw new BadRequestException(
        'Your subscription is managed through the App Store or Google Play — manage your existing subscription there',
      );
    }
    // And the same question asked of the CHAINS THEMSELVES, because the column
    // above cannot answer it once a rider can hold both sides:
    // `subscription_provider` is single-valued, so someone with a Stripe history
    // and a live store chain reads `stripe` — or null — while Apple or Google
    // bills them right now.
    //
    // Deliberately NOT the rollup. That column is a CACHE with an expiry, and it
    // carries the MAX tier: when a Premium chain lapses while a Pro chain keeps
    // renewing, the rollup is stale until recomputation runs, and a gate reading
    // it would let a Stripe checkout through during that window while the store
    // is still billing. A guard against double-billing has to read the thing
    // that bills, not a derived summary of it.
    //
    // Checked BEFORE any Stripe call, and on LIVE chains only, so a rider whose
    // store subscription has genuinely ended is not trapped out of
    // re-subscribing.
    if ((await this.loadLiveChains(userId)).length > 0) {
      throw new BadRequestException(
        'Your subscription is managed through the App Store or Google Play — manage your existing subscription there',
      );
    }
    const liveSnapshot =
      user.stripe_customer_id != null
        ? await this.stripe.getBillingSnapshot({
            customerId: user.stripe_customer_id,
            subscriptionId: user.stripe_subscription_id,
          })
        : null;
    // This guard deliberately reads the BILLED PRODUCT tier, NOT the rider's
    // entitlement (unlike `buildSubscriptionSnapshot`, which gates the live
    // tier on `entitling`). The question here is "is there already a Stripe
    // subscription that a second Checkout would duplicate?", and a paid
    // subscription gone `unpaid` still exists at Stripe: it must be resolved in
    // the portal. Minting a second subscription for it would land in the
    // two-session conflict path and get cancelled + refunded.
    const currentTier =
      liveSnapshot?.currentPlan?.tier ?? user.subscription_tier;
    const currentStatus =
      liveSnapshot?.currentPlan?.status ?? user.subscription_status;

    if (
      currentTier !== 'free' &&
      ['active', 'trialing', 'past_due'].includes(currentStatus)
    ) {
      throw new BadRequestException(
        'Existing subscriptions must be changed in the billing portal',
      );
    }

    let customerId = await this.stripe.ensureCustomer({
      existingCustomerId: user.stripe_customer_id,
      email: user.email,
      name: user.display_name,
      userId: user.id,
    });
    // Persist a FRESHLY-MINTED customer id FIRST-WRITER-WINS. `ensureCustomer`
    // reuses an already-stored customer verbatim (it short-circuits on
    // `existingCustomerId`), so this branch only runs when the slot was null at
    // entry and we just created a NEW Stripe customer. Two concurrent INITIAL
    // checkouts each mint a DIFFERENT customer; an unguarded `save` lets the
    // second overwrite the first — and if the OTHER session then wins the
    // subscription claim, the completion guard can no longer repair the id (the
    // column is already non-null with the wrong customer). Persist under a
    // `stripe_customer_id IS NULL` guard so only the first store lands. If we
    // did NOT win (affected 0 → a concurrent session stored first), RE-READ the
    // stored winner and use THAT for this Checkout session. Our just-created
    // Stripe customer is NOT a harmless discard: `ensureCustomer` already
    // stamped it with the rider's email, name, and `user_id` metadata, so
    // leaving it stranded strews rider PII across an orphan customer that
    // account deletion (which only removes the STORED `stripe_customer_id`)
    // will never reach. DELETE the orphan we just minted before falling back to
    // the stored winner. Best-effort: `deleteCustomer` tolerates
    // `resource_missing`, but any other delete failure must NOT break checkout —
    // log and continue against the stored winner's customer. Net: both
    // concurrent sessions check out against the SAME customer and no orphan PII
    // lingers.
    if (customerId !== user.stripe_customer_id) {
      const claimed = await this.userRepo.update(
        { id: user.id, stripe_customer_id: IsNull() },
        { stripe_customer_id: customerId, updated_at: new Date() },
      );
      if (!claimed.affected) {
        const orphanCustomerId = customerId;
        const stored = await this.userRepo.findOne({
          where: { id: user.id },
          select: { id: true, stripe_customer_id: true },
        });
        if (stored?.stripe_customer_id) {
          customerId = stored.stripe_customer_id;
        }
        try {
          await this.stripe.deleteCustomer(orphanCustomerId);
        } catch (err) {
          this.logger.error(
            `Failed to delete orphan Stripe customer ${orphanCustomerId} after losing customer-claim race`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    }

    return this.stripe.createCheckoutSession({
      customerId,
      priceId: this.priceIdForTier(dto.tier),
      // `{CHECKOUT_SESSION_ID}` is a Stripe placeholder, substituted on the
      // redirect back. The companion cannot hold state across Checkout (a full
      // cross-origin navigation remounts the page), and a plain `?trial=1`
      // marker would be rider-forgeable once it round-trips through the
      // browser. The id is forgeable too — which is why it is VERIFIED against
      // Stripe, and bound to the caller, rather than trusted.
      successUrl: `${this.subscriptionPageUrl()}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${this.subscriptionPageUrl()}?checkout=canceled`,
      userId: user.id,
      tier: dto.tier,
      trialDays: this.isIntroTrialEligible(user) ? INTRO_TRIAL_DAYS : null,
    });
  }

  /**
   * Confirms a Checkout the rider was just redirected back from, and reports
   * whether it started a free trial.
   *
   * The session id reaches us through the rider's address bar, so it proves
   * nothing on its own. Two checks make the answer trustworthy:
   *
   * 1. the session is read back from Stripe — a made-up id verifies as nothing;
   * 2. its `metadata.user_id` must be the CALLER. A success URL is shareable
   *    and leaks easily, so without this another rider's completed session id
   *    would produce a genuine-looking confirmation for someone who bought
   *    nothing.
   *
   * Every negative answers the same way: `completed: false`. A caller probing
   * ids learns only "not yours or not complete", never that a session exists.
   */
  async verifyCheckoutSession(
    userId: string,
    dto: VerifyCheckoutSessionDto,
  ): Promise<VerifyCheckoutSessionResponseDto> {
    const denied: VerifyCheckoutSessionResponseDto = {
      completed: false,
      trial_started: false,
    };
    const session = await this.stripe.getCheckoutSession(dto.session_id);
    if (session === 'missing') return denied;
    if (session.metadata?.user_id !== userId) {
      this.logger.warn(
        `Checkout session ${dto.session_id} verified by user ${userId} it does not belong to`,
      );
      return denied;
    }
    // The CUSTOMER as well as the metadata. Webhook ownership resolves by
    // customer first (`findUserForSubscriptionEvent`), so a session whose
    // metadata names this rider while its customer belongs to another account
    // would confirm here and activate elsewhere — two answers to one question.
    // Requiring both keeps this endpoint agreeing with the path that actually
    // grants entitlement.
    const sessionCustomerId =
      typeof session.customer === 'string'
        ? session.customer
        : (session.customer?.id ?? null);
    const user = await this.getUserById(userId);
    if (
      user.stripe_customer_id === null ||
      sessionCustomerId !== user.stripe_customer_id
    ) {
      this.logger.warn(
        `Checkout session ${dto.session_id} customer ${sessionCustomerId ?? 'none'} does not match user ${userId}`,
      );
      return denied;
    }
    if (session.status !== 'complete') return denied;
    // `complete` is not the same as paid. With an asynchronous payment method
    // (SEPA debit, bank transfer) Stripe completes the session while the
    // payment is still `unpaid` and may yet fail — no entitlement activates,
    // so "Subscription confirmed" would be a payment claim we cannot support.
    // `no_payment_required` is the legitimate trial case: nothing is charged
    // up front, which is exactly what this endpoint exists to confirm.
    if (
      session.payment_status !== 'paid' &&
      session.payment_status !== 'no_payment_required'
    ) {
      return denied;
    }

    // `subscription` is expanded by the client. A string (or null) means
    // Stripe gave us nothing to inspect, and we do not confirm a subscription
    // we cannot see.
    const subscription = session.subscription;
    if (typeof subscription !== 'object' || subscription === null) {
      return denied;
    }
    // A completed session does not mean a LIVE subscription. A duplicate
    // checkout cancelled by reconciliation, an `incomplete` subscription
    // awaiting further payment action, or an old success URL reopened long
    // after cancellation all reach this point — and "your plan is being
    // activated" is false for every one of them. Only an entitling state earns
    // a positive answer.
    if (
      subscription.status !== 'active' &&
      subscription.status !== 'trialing'
    ) {
      return denied;
    }

    return {
      completed: true,
      trial_started: subscription.status === 'trialing',
    };
  }

  async createPortalSession(
    userId: string,
    dto: CreatePortalSessionDto,
  ): Promise<RedirectUrlResponseDto> {
    const user = await this.getUserById(userId);
    // Gate on whether a STRIPE SIDE EXISTS, not on the legacy provider slot —
    // and it must match `portal_available` in the snapshot exactly, because the
    // snapshot ADVERTISES this endpoint. A rider holding both sides has
    // `subscription_provider` reading `apple` or `google` while Stripe is still
    // charging them, so a provider-gated endpoint answers 400 to the very link
    // the API just told the client to show. They are then unable to cancel the
    // subscription that is billing them — the failure the flag was fixed to
    // prevent, moved one layer down where the flag cannot see it.
    //
    // The original intent survives where it still applies: a store-managed rider
    // whose only Stripe trace is a lingering customer id has no subscription for
    // the portal to manage, so they are still refused.
    if (!user.stripe_customer_id) {
      throw new BadRequestException(
        'Billing has not been set up for this account',
      );
    }
    const isStoreManaged =
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google';
    if (isStoreManaged && user.stripe_subscription_id == null) {
      throw new BadRequestException(
        'Your subscription is managed through the App Store or Google Play — manage your existing subscription there',
      );
    }

    const flow = dto.flow ?? 'manage';
    const redirectUrl = this.subscriptionPageUrl();

    if (flow === 'manage') {
      return this.stripe.createPortalSession({
        customerId: user.stripe_customer_id,
        returnUrl: redirectUrl,
        flow: null,
      });
    }

    if (
      (flow === 'subscription_cancel' || flow === 'subscription_update') &&
      !user.stripe_subscription_id
    ) {
      throw new BadRequestException(
        'This account does not have an active subscription to manage',
      );
    }

    return this.stripe.createPortalSession({
      customerId: user.stripe_customer_id,
      returnUrl: redirectUrl,
      flow: {
        type: flow,
        subscriptionId: user.stripe_subscription_id ?? undefined,
        afterCompletionUrl: redirectUrl,
      },
    });
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const event = this.stripe.constructWebhookEvent(payload, signature);

    if (event.type === 'checkout.session.completed') {
      await this.handleCheckoutCompleted(event.data.object);
      return;
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      await this.handleSubscriptionUpdated(
        event.data.object,
        event.type === 'customer.subscription.deleted',
      );
    }
  }

  private async handleCheckoutCompleted(
    session: StripeCheckoutSession,
  ): Promise<void> {
    const userId = session.metadata?.['user_id'];
    if (!userId) return;
    const nextCustomerId =
      typeof session.customer === 'string' ? session.customer : null;
    const nextSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : null;
    const user = await this.findUserForSubscriptionEvent(
      nextCustomerId,
      userId,
    );
    if (!user) return;

    if (!nextCustomerId && !nextSubscriptionId) return;

    // `stripe_customer_id` identifies the CUSTOMER, not the subscription
    // ownership slot — but it is still FIRST-WRITER-WINS, not unconditional.
    // Two racing INITIAL Checkout requests (before any customer id is stored)
    // create DIFFERENT Stripe customers; a delayed/redelivered
    // `checkout.session.completed` for the LOSING session would otherwise
    // overwrite the stored winner's customer id, so later billing snapshots and
    // portal sessions would target the loser's customer (wrong payment methods,
    // wrong invoices). The loser's orphan customer/subscription is already
    // refunded + cancelled by the two-session conflict path, so we only need to
    // stop it clobbering the slot: write the id ONLY when the slot is still
    // empty (`stripe_customer_id IS NULL`). Whichever completion lands first
    // wins; every later one no-ops. (`ensureCustomer` reuses an already-stored
    // customer id, so a non-racing subsequent checkout never mints a second
    // customer to begin with.)
    if (nextCustomerId) {
      await this.userRepo.update(
        { id: user.id, stripe_customer_id: IsNull() },
        {
          stripe_customer_id: nextCustomerId,
          updated_at: new Date(),
        },
      );
    }

    // `stripe_subscription_id` IS the ownership slot, so its write must be
    // ownership-guarded — NOT unconditional. In a two-Checkout-session race a
    // delayed/redelivered `checkout.session.completed` for the LOSING session
    // would otherwise overwrite the stored winner id with the loser's; the
    // loser's later `customer.subscription.deleted` would then satisfy
    // `clearStripeTerminal`'s identity guard (stored id now matches the loser)
    // and wipe the still-active WINNING subscription — rider charged, no
    // entitlement. Guard the write so it only lands when the slot is unclaimed
    // (or already this subscription) and not owned by another provider. This
    // mirrors `claimForStripe`, which the sibling
    // `customer.subscription.created/updated` event runs for the same id, so
    // the two writers agree on ownership.
    if (nextSubscriptionId) {
      await this.userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          stripe_subscription_id: nextSubscriptionId,
          updated_at: new Date(),
        })
        .where('id = :id', { id: user.id })
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: nextSubscriptionId },
        )
        .execute();
    }
  }

  private async handleSubscriptionUpdated(
    subscription: StripeSubscription,
    isDeleted: boolean,
  ): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : null;
    const metadataUserId = subscription.metadata?.['user_id'] ?? null;
    const user = await this.findUserForSubscriptionEvent(
      customerId,
      metadataUserId,
    );
    if (!user) return;

    // Serialise the whole event against the rider's OTHER subscription-mutation
    // flows (a store-ingestion flow landing an Apple/Google purchase, or a
    // concurrent Stripe delivery) under the per-rider lock, so their
    // read→decide→write steps can't interleave (e.g. a Stripe trial and a store
    // trial both consuming the once-per-rider `billing_trial_used_at` marker).
    // The in-flow guards stay as defense-in-depth.
    await this.subscriptionLock.runExclusive(user.id, (manager, lease) =>
      this.applyStripeSubscriptionEvent(
        user,
        subscription,
        isDeleted,
        manager,
        lease,
      ),
    );
  }

  /**
   * Retire any open `exclusivity_conflict` filed against a Stripe subscription
   * that has just WON the slot.
   *
   * A reconciliation row is a point-in-time judgement about mutable state, so it
   * goes stale the moment that state changes. Leaving one open after its subject
   * becomes the rider's valid subscription means an operator draining the queue
   * refunds or revokes exactly the thing they should not.
   *
   * Scoped on BOTH axes deliberately, and each one matters for a different
   * reason:
   *
   *  - **Subscription id** — a conflict row for a DIFFERENT subscription of the
   *    same rider still records a genuine loss and must stay open. Only rows
   *    whose subject just won are invalidated.
   *  - **Rider id** — a conflict row is filed against the rider whose event
   *    LOST, so an open row carrying this subscription id may belong to a
   *    DIFFERENT rider: it records "rider B's event referenced a subscription
   *    that rider A owns". Rider A reasserting ownership does not make that
   *    anomaly moot — B is still billed for a subscription bound to someone
   *    else, which is exactly what the operator must see. Supersession is only
   *    available where the later writer may overwrite the earlier one; across
   *    riders ownership is exclusive, so it is not.
   *
   * Dropping either filter turns a retirement into a silent loss of a real
   * anomaly, which is strictly worse than leaving a stale row for the drain.
   *
   * **Callers must only invoke this when ownership was actually written.** A
   * `preservesGrant` event deliberately omits the ownership fields (see
   * `ownershipFields`) on BOTH the transition and claim paths, so it reports
   * success while leaving the Stripe slot unowned. The conflict row's subject
   * did not win anything in that case, and retiring it would discard the durable
   * record of a subscription that still has no valid home.
   *
   * Takes the caller's manager so the claim path can run it inside the claim's
   * own transaction; the already-committed transition path passes the pool
   * manager — see that call site for why nothing better is available there.
   *
   * `retireOpenWith` does this in ONE `status = 'open'`-guarded UPDATE rather
   * than a find followed by per-row resolves: the read takes no lock, so a drain
   * or operator resolving one of those rows in between would have its outcome
   * (`refunded`, `server_canceled`, …) silently overwritten with
   * `superseded_by_claim`. Rows resolved concurrently simply no longer match.
   */
  private async retireSupersededConflicts(
    manager: EntityManager,
    userId: string,
    stripeSubscriptionId: string,
  ): Promise<void> {
    await this.storeReconciliation.retireOpenWith(
      manager,
      {
        userId,
        provider: 'stripe',
        reason: 'exclusivity_conflict',
        stripeSubscriptionId,
      },
      'superseded_by_claim',
    );
  }

  private async applyStripeSubscriptionEvent(
    resolvedUser: User,
    eventSubscription: StripeSubscription,
    isDeletedEvent: boolean,
    // The pool manager from the per-rider lock: DB work runs on it (a pooled
    // connection per statement, none held across an API call — see
    // `SubscriptionMutationLockService`).
    manager: EntityManager,
    // Fences the destructive Stripe compensation writes: `lease.assertHeld()` is
    // awaited immediately before each cancel/refund/setCancelAtPeriodEnd so we
    // never compensate on a lease we've lost (Redis partition). DB writes need no
    // fence — they are CAS-guarded.
    lease: SubscriptionLockLease,
  ): Promise<void> {
    const userRepo = manager.getRepository(User);
    // Confirm we are STILL the holder before the re-read below. Since #1138 the
    // fence is stamped at lock acquisition, so stragglers are already locked out
    // at the DB by the time this runs — what this adds is an EARLY abort: a
    // holder whose lease was lost stops here (retryable 503, Stripe redelivers)
    // instead of paying for the Stripe re-query and the decisions below before
    // failing at its first guarded write.
    //
    // That matters because those decisions rest on state a straggler could have
    // corrupted — e.g. a stale activation landing after a deletion handler read
    // `previousTier`, letting it clear a now-active subscription AND skip the
    // cancellation notice.
    await lease.assertFenceCurrent();

    // RE-READ the rider UNDER the advisory lock (and now behind our published
    // fence). `handleSubscriptionUpdated` resolves the rider BEFORE acquiring the
    // lock (it needs the id for the lock key), so that pre-lock snapshot can be
    // stale — e.g. a concurrent Apple terminal validation cleared the provider
    // while this event waited on the lock. Every subscription-state decision below
    // (the trial-eligibility pre-filter, ownership/exclusivity, the cancel email's
    // previous tier) must use the state as of lock acquisition, not the pre-lock
    // read; otherwise a stale "Apple-owned" snapshot would skip the
    // ineligible-trial re-read and let `claimForStripe` grant a second trial on
    // the now-cleared slot.
    const user = await userRepo.findOne({ where: { id: resolvedUser.id } });
    // Deleted/purged between the pre-lock resolve and acquiring the lock.
    if (!user) return;

    // Finding 5b: Stripe does not guarantee delivery order and `event.created`
    // is only second-granularity, so it cannot order same-second events. Re-fetch
    // the LIVE subscription and apply that — never the event snapshot. Runs
    // inside the per-rider lock, AFTER `lease.assertFenceCurrent()` and the rider
    // re-read above — deliberately not before them: the fence publish is what
    // closes the lost-lease-straggler race described in the comment above it,
    // and a Stripe round-trip ahead of that publish would hand a lost-lease
    // straggler the round-trip's latency as extra time to land a stale guarded
    // UPDATE before the fence closes the window. Keeping this after the fence
    // (and after the read it guards) keeps that window at its original,
    // minimal size.
    const fresh = await this.stripe.getSubscription(eventSubscription.id);

    // `isDeleted` used to come solely from the event TYPE, so a delayed
    // `customer.subscription.updated` whose live state is terminal still entered
    // `claimForStripe` — which writes `subscription_provider = 'stripe'` and the
    // subscription id EVEN WHEN the tier drops to `free`, leaving a dead
    // subscription owning the slot and blocking a later Apple/Google claim.
    // Re-derive it from authoritative state as well as the event type.
    const isDeleted =
      isDeletedEvent ||
      fresh === 'missing' ||
      TERMINAL_STRIPE_STATUSES.has(fresh.status);

    // A purged subscription has no fresh object; the terminal path only needs
    // the id and the period end, both of which the event snapshot carries.
    const subscription = fresh === 'missing' ? eventSubscription : fresh;

    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : null;

    const update: UserUpdate = { updated_at: new Date() };
    if (customerId) update.stripe_customer_id = customerId;

    const periodEndSeconds = subscriptionPeriodEnd(subscription);
    const periodEnd: Date | null =
      periodEndSeconds != null ? new Date(periodEndSeconds * 1000) : null;

    // Hoisted above the terminal branch: the ending subscription's price is what
    // names the plan in the cancellation mail when the stored tier has already
    // been dropped to `free` (see `endingTier`).
    const price = subscription.items.data[0]?.price;

    // TWO FLAGS, NOT ONE — they answer different questions and both read
    // `subscription`, the RE-QUERIED live object (falling back to the event
    // snapshot only when Stripe has purged the record):
    //
    //   `isTrialActivation`  — "is this a NEW trial grant, so its ELIGIBILITY
    //                          must be checked?" Gates the
    //                          `billing_trial_used_at IS NULL` guards and the
    //                          ineligible-trial rejection paths.
    //   `consumedIntroTrial` — "did this subscription consume the rider's
    //                          once-per-rider intro trial, so the marker must
    //                          be STAMPED?" Gates the COALESCE stamps.
    //
    // They were a single boolean, which lost the stamp on a delayed delivery:
    // Stripe redelivers for up to ~3 days, so a `trialing` webhook can be
    // processed AFTER the trial has already converted, and the re-query then
    // returns `active`. A status-only flag is FALSE for that delivery, so none
    // of the stamps fire — the rider genuinely used a trial, the marker never
    // lands, and they stay `trial_eligible` for a second trial on Stripe,
    // Apple or Google.
    //
    // The stamp therefore keys off `trial_start`, which — unlike `status` —
    // SURVIVES the trial→active conversion (Stripe keeps it set for the life of
    // the subscription). `status === 'trialing'` is OR-ed in so the stamp flag
    // is a strict superset of the eligibility flag by construction: whatever we
    // ever GRANT as a trial we also STAMP, without depending on Stripe
    // populating `trial_start` on the object we happened to fetch.
    //
    // COMPUTED ABOVE THE TERMINAL BRANCH, not below it: the same delayed
    // delivery can re-query to a TERMINAL state rather than to `active` (the
    // rider cancelled the trial before we ever processed its `trialing` event),
    // and that path returns early. Declaring the flags here is what lets the
    // terminal branch record the trial before returning.
    //
    // What must NOT be done instead: OR the EVENT snapshot's status into the
    // shared boolean (`eventSubscription.status === 'trialing' || ...`). That
    // widens the ELIGIBILITY half too, arming the `billing_trial_used_at IS
    // NULL` reject-guard from a stale event body even when the authoritative
    // state shows this is an ordinary PAID activation — exactly the delayed
    // delivery above. Any rider who already has the marker set (from any
    // earlier, legitimately-used trial, on any provider) would then have this
    // paid activation's guarded UPDATE match zero rows and be misrouted into
    // the second-trial rejection path: cancelled and reconciled instead of
    // entitled.
    const isTrialActivation = subscription.status === 'trialing';
    // Never stamp for a subscription that never entitled anything (see
    // `NEVER_ENTITLED_STRIPE_STATUSES`): an aborted `incomplete` checkout can
    // carry `trial_start` without the rider ever receiving the trial, and
    // burning their single intro trial there is unrecoverable. Excluding it
    // costs nothing — if that subscription later pays and becomes
    // `trialing`/`active`, the stamp is idempotent (COALESCE) and the next
    // event self-heals the marker.
    const consumedIntroTrial =
      !NEVER_ENTITLED_STRIPE_STATUSES.has(subscription.status) &&
      (isTrialActivation || subscription.trial_start != null);

    if (isDeleted) {
      // WHICH PAID PLAN, IF ANY, IS ENDING FOR THIS RIDER?
      //
      // The stored tier answers that directly while the row still holds the
      // paid tier — but a subscription that passed through a NON-ENTITLING
      // status on its way here has already been dropped to `free` by the
      // entitlement gate below. The ordinary "rider's card finally stopped
      // working" lifecycle is exactly that shape (active -> unpaid ->
      // canceled), so keying the notice on the stored tier alone silently
      // swallowed the cancellation mail for the riders who had been paying
      // longest, while riders cancelled straight from `active` still got one.
      //
      // Fall back to the row's BILLED PROVENANCE plus the ending subscription's
      // own price. `plan_source = 'subscription'` is only ever written from an
      // ENTITLING status, so on a Stripe-owned row it means "this rider
      // genuinely held a paid plan here"; the price then names which one (the
      // subscription object still carries it on the terminal event, and on a
      // purged subscription the event snapshot does).
      //
      // NULL provenance deliberately does NOT trigger the fallback. It is
      // ambiguous by definition (`PLAN_SOURCES`: "rows predating the column,
      // indistinguishable from `subscription`"), and treating it as billed
      // would mail a cancellation for every aborted free->paid checkout — the
      // precise case this gate was written to suppress, since such a row never
      // reached an entitling status and so never got a `plan_source`.
      const previousTier = user.subscription_tier;
      let endingTier: BillingTier = previousTier;
      if (endingTier === 'free' && user.plan_source === 'subscription') {
        endingTier = this.tierFromPrice(price);
      }

      // A founder/promo/admin grant is not this subscription's to revoke. The
      // terminal clear releases the Stripe slot either way, but for a grant row
      // it must leave `subscription_tier`/`plan_source` standing.
      //
      // `claimForStripe`'s `skipOwnership` does NOT already cover this: it only
      // avoids ADDING ownership to a grant row that had none. A rider who was
      // already a paying Stripe subscriber when the grant was applied has
      // `subscription_provider = 'stripe'` on the row before any of this runs,
      // and no amount of not-writing unsets it — so this clear's guard still
      // matches and would wipe the grant (and mail a cancellation for it).
      //
      // Releasing the slot EARLIER, at the non-entitling transition, was the
      // alternative and is wrong: `unpaid`/`incomplete`/`paused` are
      // recoverable, and `TERMINAL_STRIPE_STATUSES` deliberately keeps Stripe
      // owning the slot through them so another provider cannot claim one
      // Stripe may yet reactivate. Handing it away there would let an
      // Apple/Google purchase take the slot mid-recovery, and the rider's
      // recovered subscription would then be cancelled and refunded by the
      // exclusivity path. The terminal event is the first moment we know the
      // subscription is actually over, so it is the right place to release.
      const preserveGrant = isNonSubscriptionGrant(user.plan_source);

      // RECORD TRIAL HISTORY BEFORE RETURNING. A `trialing` webhook first
      // processed after the rider already cancelled the trial (a webhook
      // outage, or anywhere inside Stripe's ~3-day redelivery window)
      // re-queries as `canceled` — or `missing`, if Stripe has purged it — and
      // lands here, above every other stamp site. The rider DID receive the
      // trial before cancelling, so returning without recording it leaves them
      // `trial_eligible` and a later Checkout mints a SECOND intro trial. This
      // is the terminal twin of the trial→active delayed delivery that
      // `consumedIntroTrial` already covers.
      //
      // `consumedIntroTrial` is reused verbatim rather than re-deriving the
      // rule, so the `NEVER_ENTITLED_STRIPE_STATUSES` carve-out still applies —
      // and it matters MORE here: `incomplete_expired` is both terminal and
      // never-entitled, so an aborted checkout whose trial never delivered must
      // not burn the rider's single trial, while a `canceled` subscription that
      // genuinely ran one must. On the `missing` path the flag reads the event
      // snapshot; `trial_start` is a REQUIRED (`number | null`) field of
      // Stripe's subscription object, so a null there means "no trial", not
      // "unknown" — and where a payload genuinely carries no trial evidence we
      // deliberately do NOT stamp rather than burn a trial on an assumption.
      //
      // Deliberately NOT gated on the clear's outcome below. Trial history is a
      // fact about the RIDER, not about which subscription currently owns the
      // slot: a stale terminal for a superseded subscription whose trial the
      // rider genuinely consumed is still evidence they consumed it, and the
      // identity guard that rejects the CLEAR says nothing about that. COALESCE
      // keeps it idempotent and monotonic, so a redelivery — or the retry after
      // the stale-fence 503 the clear raises — can never re-date an earlier
      // trial.
      //
      // Fence-guarded like every other write here, so a flow whose lease was
      // lost matches 0 rows and commits nothing before that 503: the stamp can
      // neither outlive its lease nor disturb the retry. Orthogonal to
      // `preserveGrant` — it touches only the trial marker, never the tier or
      // provenance, so it perturbs no entitlement decision in either direction.
      if (consumedIntroTrial) {
        await userRepo.update(
          {
            id: user.id,
            subscription_lock_fence: LessThanOrEqual(lease.fenceToken),
          },
          {
            billing_trial_used_at: trialMarkerStamp(),
            updated_at: new Date(),
            subscription_lock_fence: lease.fenceToken,
          },
        );
      }

      // Identity-guarded terminal clear: the guard only fires when the row
      // is still Stripe-owned AND holds this exact subscription id, so a
      // stale `customer.subscription.deleted` for a subscription the rider
      // has since replaced (a superseded/re-subscribed id) is a no-op and
      // can't wipe the current, still-active subscription. It is the
      // authoritative writer of the reset fields (provider, plan_source,
      // subscription id, tier, status, cancel flag).
      const cleared = await this.providerClaim.clearStripeTerminal(
        user.id,
        subscription.id,
        lease.fenceToken,
        { preserveGrant, manager },
      );
      // Only fire the cancellation mail when the clear actually happened
      // (a stale/superseded terminal returns false → no clear, no email)
      // AND the rider was actually on a paid plan beforehand. Stripe also
      // fires `customer.subscription.deleted` when a free→paid trial gets
      // aborted before activation, which would otherwise bombard the user
      // with a cancellation notice for a plan they never had. `endingTier`
      // (above) is what answers "was there a paid plan" now that a dropped
      // tier can no longer be read as "there never was one".
      //
      // `cleared` means "the row changed", which is no longer the same question
      // as "the rider lost their plan": a preserved grant releases the slot
      // while the rider keeps their tier, so nothing is ending for them and no
      // notice is due.
      if (cleared && !preserveGrant && endingTier !== 'free') {
        const planName = BILLING_PLAN_META[endingTier].name;
        // Reassert the lease before enqueuing: if we lost it after the guarded
        // clear and a newer delivery reactivated the rider, we must NOT enqueue a
        // cancellation over the newer active state. A lost lease throws
        // (retryable) before the enqueue.
        await lease.assertHeld();
        // Enqueue for durable, out-of-lock delivery carrying this transition's
        // notification generation: the consumer drops it if a newer transition
        // has bumped the generation (a reactivation) or the state no longer
        // matches, so a cancellation can't outlive it — and the send never runs
        // inline where a slow Resend call could push the webhook past Stripe's
        // ~20s timeout and trigger a duplicate.
        const generation = await this.nextNotifyGeneration(
          user.id,
          manager,
          lease.fenceToken,
        );
        await this.enqueueSubscriptionNotification({
          kind: 'cancelled',
          userId: user.id,
          planName,
          periodEnd: periodEnd?.toISOString() ?? null,
          generation,
          // The SOURCE this notice is about, for source-aware delivery: the
          // consumer judges it against THIS subscription rather than the
          // rider's resolved state, so a live store chain (or a Stripe
          // successor) cannot suppress a real Stripe cancellation.
          source: { provider: 'stripe', identity: subscription.id },
        });
      }
      // The Stripe side just stopped future billing, so any provisional
      // overlap naming this subscription is over — retire it silently rather
      // than leaving durable work for a double-charge that can no longer
      // happen. Runs after the clear like the transition path's conflict
      // retirement: it cannot share the guarded UPDATE's implicit transaction,
      // and a crash in between leaves rows the deadline sweep retires — the
      // same already-accepted exposure. The event's id and created travel as
      // ONE record: the writer uses the created time only when this id is the
      // identity it emits, so a delayed terminal for a superseded subscription
      // cannot attach the old record's chronology to the current one.
      // `terminal: true` is what makes this correct when the clear above
      // matched ZERO rows (a grant-preserving ownerless checkout): the
      // persisted status still says `past_due` there, and without the flag
      // the sync would read this event's id as fresh billing evidence —
      // resurrecting the very subscription this event just ended.
      await this.storeChainWriter.syncOverlapsAfterBillingChange(
        manager,
        user.id,
        {
          subscriptionId: subscription.id,
          createdAt: new Date(subscription.created * 1000),
          terminal: true,
        },
      );
      return;
    }

    // Finding 5a: the paid tier is persisted ONLY for an entitling raw status.
    // Without this, a subscription carrying a paid price but no successful
    // payment (`incomplete`, `incomplete_expired`, `unpaid`) still reached
    // `claimForStripe` — which has no eligibility guard of its own — and the
    // rider held paid features for free.
    //
    // The drop to `free` is scoped to BILLED provenance (finding 5a follow-up).
    // A founder/promo/admin-granted rider holds a paid tier with NO billed
    // subscription behind it; when they follow the companion's grant-to-Checkout
    // flow and the initial payment leaves the subscription `incomplete`, an
    // unconditional `free` revoked a grant the failed checkout never paid for
    // (and `claimForStripe` cleared `plan_source` with it), so the rider lost
    // access they still legitimately had. Preserve BOTH fields for those rows
    // and drop to `free` only when the row represents a billed subscription —
    // which includes a NULL `plan_source` (see `NON_SUBSCRIPTION_PLAN_SOURCES`).
    // A grant row already sitting at `free` has nothing to preserve, and
    // attributing a `free` tier to a plan source would break the "free has no
    // plan to attribute" invariant below, so it falls through to the else.
    //
    // This can NOT resurrect a confirmation email or an activation transition
    // for a rider who did not convert: `statusFromSubscription` returns
    // `active`/`trialing` ONLY for the raw statuses of the same name, both
    // entitling, so a non-entitling event always lands on `past_due`/`canceled`
    // and `willActivate` is false regardless of the preserved tier.
    //
    // The user row is the RE-READ under the lock, so the preserved grant is the
    // provenance as of lock acquisition, never the stale pre-lock snapshot.
    const entitling = isEntitlingStripeStatus(subscription.status);
    const newStatus = this.statusFromSubscription(subscription.status);
    const preservesGrant =
      !entitling &&
      isNonSubscriptionGrant(user.plan_source) &&
      user.subscription_tier !== 'free';
    let newTier: BillingTier;
    let planSource: PlanSource | null;
    if (entitling) {
      newTier = this.tierFromPrice(price);
      // The tier now comes from Stripe, so record 'subscription' provenance
      // (a launch-granted 'founder' who converts to paid becomes a paying
      // customer in the admin view — the intended founder→paying transition,
      // which an entitling status still performs). An unmapped price resolves
      // to 'free', which has no plan to attribute — clear the marker.
      planSource = newTier === 'free' ? null : 'subscription';
    } else if (preservesGrant) {
      newTier = user.subscription_tier;
      planSource = user.plan_source;
    } else {
      newTier = 'free';
      // The TIER drops (that is the entitlement fix) but the row's PROVENANCE
      // is retained — a subscription that does not entitle has no authority to
      // rewrite where this rider's plan came from. `plan_source` is therefore
      // the row's HISTORICAL billed-plan signal, and the terminal handler above
      // depends on it: once the tier has been dropped to `free` by an `unpaid`
      // transition, `subscription_tier` can no longer answer "was this rider on
      // a paid plan that is now ending?", and nulling the provenance here
      // destroyed the only other evidence at exactly the same moment. That
      // swallowed the cancellation notice for the riders who had been paying
      // longest (active -> unpaid -> canceled).
      //
      // RETAINING the existing value is not enough on its own, because a LEGACY
      // paid rider carries `null`: migration 1796000000000 added `plan_source`
      // with no backfill, and `PLAN_SOURCES` documents null as "rows predating
      // the column (indistinguishable from `subscription`)". Null therefore
      // covers two opposite cases, and answering "no notice" for both
      // over-corrects — it silences legacy paying riders to protect aborted
      // checkouts.
      //
      // The PRE-TRANSITION TIER separates them, and it is the very signal the
      // original `previousTier !== 'free'` gate used — captured here, while it
      // is still true, instead of after the tier has been cleared:
      //
      //   paid tier on the row already  -> the rider demonstrably held a paid
      //                                    plan, so RECORD `subscription`
      //   row is still `free`           -> an aborted free->paid checkout that
      //                                    never entitled anything, so leave the
      //                                    provenance alone (null stays null)
      //                                    and the terminal handler stays silent
      //
      // `user` is the pre-write re-read taken under the lock at the top of this
      // method and never reassigned, so this reads the tier as of BEFORE this
      // event's writes — reading it afterwards would make the test always false.
      //
      // This cannot mislabel a founder/promo/admin grant. A grant holding a paid
      // tier is claimed by the `preservesGrant` branch above and never reaches
      // here; the only grant that does is one already sitting at `free`, which
      // fails the paid-tier test and keeps its own provenance. So a `subscription`
      // stamp here always describes a genuinely billed row.
      //
      // Normalized to an explicit `null` rather than passed through: these
      // values reach TypeORM `.set()`/`update()` payloads, where an `undefined`
      // means "leave the column alone" instead of "write NULL". The hydrated
      // entity never yields `undefined` here, so this is belt-and-braces
      // against a partially-selected row silently becoming a no-op write.
      planSource =
        user.subscription_tier !== 'free'
          ? 'subscription'
          : (user.plan_source ?? null);
    }

    // PRESERVING THE GRANT IS NOT ENOUGH ON ITS OWN — the subscription must
    // also not take the slot. Recording a never-entitling subscription as the
    // row's Stripe owner arms the terminal event that follows roughly a day
    // later (`incomplete_expired`, or the `customer.subscription.deleted` Stripe
    // emits for an abandoned checkout): `clearStripeTerminal` matches on
    // `subscription_provider = 'stripe'` AND the stored subscription id, and
    // resets the tier and `plan_source` to free — revoking the grant this branch
    // just protected. Worse, the cancellation mail is gated on that clear having
    // actually happened, so the rider would ALSO be told the plan we preserved
    // was cancelled.
    //
    // Leaving `subscription_provider` NULL makes that terminal clear a no-op:
    // its provider guard is a STRICT equality, not `IS NULL OR = 'stripe'` (see
    // `ProviderClaimService.clearStripeTerminal`, unlike its Apple sibling which
    // deliberately also matches the unowned same-OTID tombstone). No clear, no
    // wipe, no mail — one change closes both.
    //
    // What is deliberately NOT skipped: the exclusivity WHERE guard still runs
    // on every writer below, so an Apple/Google-owned row or a different
    // subscription id is still rejected and conflict detection is unaffected.
    // `handleCheckoutCompleted` may already have recorded
    // `stripe_subscription_id` for this checkout under its own
    // `(subscription_provider IS NULL OR = 'stripe')` guard; that stays safe,
    // because the id ALONE cannot satisfy the terminal clear's provider guard.
    //
    // A later SUCCESSFUL payment on this same subscription is unaffected: it is
    // entitling, so `preservesGrant` is false and it takes ownership through the
    // normal activation claim, whose `stripe_subscription_id IS NULL OR = :sub`
    // guard the recorded id still satisfies. That is the founder→paying
    // conversion, and it still works.
    const ownershipFields = preservesGrant
      ? {}
      : {
          subscription_provider: 'stripe' as const,
          stripe_subscription_id: subscription.id,
        };
    // A `trialing` activation consumes the rider's single free trial, so the
    // once-per-rider marker must be stamped — but ATOMICALLY, in the SAME guarded
    // UPDATE that grants the tier (below), never in a separate follow-up
    // statement. The prior code granted the tier in the activation UPDATE and
    // stamped `billing_trial_used_at` in a LATER `userRepo.update`; an
    // overlapping terminal Stripe delivery clearing the slot between the two
    // statements left a window where a concurrent store trial validation could
    // observe `billing_trial_used_at IS NULL` and grant a SECOND
    // trial. Folding the stamp into the grant UPDATE closes that window. The fold
    // uses `COALESCE(billing_trial_used_at, NOW())`, so it is safe to apply on
    // EVERY trial activation: an already-set marker (a re-subscription into a
    // trial, or a marker set concurrently between our read and write) is
    // preserved, never re-dated (idempotent, monotonic). Both trial flags are
    // computed ABOVE the terminal branch — see `consumedIntroTrial`.

    // Atomic activation-transition claim — the winner-only gate for the
    // confirmation email. Stripe emits multiple `customer.subscription
    // .updated` events per period (proration re-bills, payment-method
    // changes, scheduled cancel toggles) and may retry the SAME event in
    // parallel. Two concurrent handlers for the same canceled→active
    // transition would otherwise both read pre-update `subscription_status
    // ='canceled'` from the in-memory `user`, both pass the
    // `!wasActiveBefore && isActiveNow` gate, and both fire the
    // confirmation email — a textbook double-send.
    //
    // Gating on a conditional UPDATE moves the check into Postgres
    // row-level locking: only one of two concurrent transactions sees
    // `subscription_status NOT IN ('active', 'trialing')` at its
    // locked-read instant; the loser sees affected: 0 and skips the
    // email. The Stripe-ownership + subscription-identity guards are
    // ANDed in so this claim can't spuriously flip status (or fire an
    // email) for a losing two-session event that the exclusivity claim
    // below rejects.
    //
    // Critically, this claim ALSO writes `subscription_provider='stripe'`
    // and `stripe_subscription_id` — it doesn't just flip status. That
    // makes the transition winner LOCK ownership of the slot: a second
    // session with a DIFFERENT id can then no longer win `claimForStripe`
    // below (its `stripe_subscription_id IS NULL OR = :sub` guard now
    // fails). Without this, the transition winner and the exclusivity
    // winner could DIVERGE — one handler wins the status-claim but loses
    // `claimForStripe` (returning at the conflict branch before
    // dispatching), while the true owner has `wonActivationTransition=
    // false` — dropping the confirmation entirely. Locking ownership here
    // guarantees the status-claim winner IS the `claimForStripe` winner,
    // so exactly one handler both owns the row and sends the email.
    const willActivate =
      (newStatus === 'active' || newStatus === 'trialing') &&
      newTier !== 'free';
    let wonActivationTransition = false;
    if (willActivate) {
      // The transition claim writes ALL authoritative fields (tier, status,
      // period end, cancel flag, provider, subscription id, plan source), not
      // just status — so a crash (or a `claimForStripe` failure) right after
      // this UPDATE commits leaves a COMPLETE, correct row instead of an
      // active-status-but-no-tier/period/cancel partial one. The winner/dispatch
      // decision comes from THIS one UPDATE's `affected`; `claimForStripe` below
      // stays the conflict detector and the writer for the non-transition
      // (already-active) path, re-writing these same values idempotently.
      const claimQb = userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          subscription_status: newStatus,
          // Ownership is written unconditionally here — unlike the past-due
          // claim, the reclaim and `claimForStripe`, this branch cannot run
          // while a grant is being preserved: `willActivate` requires
          // `newStatus` to be active/trialing, which `statusFromSubscription`
          // only ever returns for the entitling raw statuses of the same name.
          subscription_provider: 'stripe',
          stripe_subscription_id: subscription.id,
          subscription_tier: newTier,
          subscription_current_period_end: periodEnd,
          subscription_cancel_at_period_end: subscription.cancel_at_period_end,
          plan_source: planSource,
          subscription_lock_fence: lease.fenceToken,
          // Fold the once-per-rider trial marker into the SAME atomic grant so
          // the tier and the marker commit together (see `consumedIntroTrial`).
          // COALESCE preserves an already-set stamp, so this never re-dates an
          // earlier trial; omitted entirely for an activation that never
          // involved a trial, leaving the column untouched. Keyed on the STAMP
          // flag, not the eligibility flag, so a trial that already converted to
          // `active` before this delayed delivery still marks the trial used.
          ...(consumedIntroTrial
            ? {
                billing_trial_used_at: trialMarkerStamp(),
              }
            : {}),
        })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status NOT IN ('active', 'trialing')")
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: subscription.id },
        )
        // Fence: a lease-lost stale flow can't win the activation transition over
        // a newer acquisition (which resurrection depends on — see the fence doc).
        .andWhere('subscription_lock_fence <= :fence', {
          fence: lease.fenceToken,
        });
      // FINDING 2 (round 25): guard the trial GRANT on CURRENT eligibility. Round
      // 24 made the trial STAMP atomic (COALESCE) but NOT the eligibility, so if
      // an Apple trial consumed `billing_trial_used_at` (and terminal-cleared its
      // slot, freeing it) between Checkout creation and this delayed `trialing`
      // webhook, the grant still ran → the rider got BOTH trials. Requiring
      // `billing_trial_used_at IS NULL` here makes an INELIGIBLE trial activation
      // affect 0 rows; the lost-guard handler below then cancels + reconciles it
      // instead of granting. Applied ONLY to the trial-activation path — a
      // non-trial/paid activation is unaffected.
      if (isTrialActivation) {
        claimQb.andWhere(TRIAL_ELIGIBLE_PREDICATE);
      }
      const claim = await claimQb.execute();
      wonActivationTransition = (claim.affected ?? 0) > 0;
    }

    // FINDING 2 (round 25): handle a LOST trial-eligibility guard. A `trialing`
    // activation whose grant UPDATE above affected 0 rows may have lost SOLELY
    // because `billing_trial_used_at` is already set (the rider consumed their
    // once-per-rider trial elsewhere, e.g. an Apple trial that then freed the
    // slot). Detect that specific case and cancel + reconcile INSTEAD of falling
    // through to `claimForStripe`, which — with no eligibility guard of its own —
    // would otherwise re-grant the tier on the now-free slot (the double trial
    // this finding prevents). We must distinguish it from the benign losers that
    // also produce 0 rows and MUST fall through: a concurrent delivery of the
    // SAME event that already granted the trial (the row is now live for this
    // sub), and a rival-provider/different-id exclusivity conflict (handled by
    // the `claimForStripe` 'conflict' branch, which already cancels + refunds).
    if (isTrialActivation && willActivate && !wonActivationTransition) {
      // Cheap pre-filter on the INITIAL snapshot: only the ineligible-candidate
      // shape needs the authoritative re-read — the slot is claimable by THIS
      // Stripe subscription (so `claimForStripe` below WOULD grant the tier) and
      // is not already live for the rider. A different-id resubscription reclaim
      // or a rival-provider exclusivity conflict is handled by the
      // `claimForStripe` path instead and must NOT trigger this re-read.
      const initialClaimable =
        (user.subscription_provider == null ||
          user.subscription_provider === 'stripe') &&
        (user.stripe_subscription_id == null ||
          user.stripe_subscription_id === subscription.id);
      const initialLive =
        user.subscription_status === 'active' ||
        user.subscription_status === 'trialing';
      // Not the ineligible shape (a different-id reclaim or rival-provider
      // conflict) → leave it to the existing claim/reclaim path below.
      if (initialClaimable && !initialLive) {
        const fresh = await userRepo.findOne({
          where: { id: user.id },
          select: {
            id: true,
            subscription_status: true,
            subscription_provider: true,
            stripe_subscription_id: true,
            billing_trial_used_at: true,
          },
        });
        // A concurrent delivery of THIS event legitimately granted the trial —
        // the row is now live for this rider. That is a normal idempotent loser,
        // NOT an ineligible trial: fall through so `claimForStripe` no-ops.
        // Re-confirm on the authoritative row that the slot is still claimable by
        // THIS Stripe subscription (so `claimForStripe` below WOULD grant the
        // tier on it) — as opposed to a rival-provider or different-id slot, a
        // genuine exclusivity conflict the `claimForStripe` 'conflict' branch
        // already cancels + reconciles.
        const isIneligible = this.isIneligibleTrialRejection(fresh, {
          isAlreadyLiveForRider: (row) =>
            row.subscription_status === 'active' ||
            row.subscription_status === 'trialing',
          isClaimableSlot: (row) =>
            (row.subscription_provider == null ||
              row.subscription_provider === 'stripe') &&
            (row.stripe_subscription_id == null ||
              row.stripe_subscription_id === subscription.id),
        });
        if (isIneligible) {
          // Do NOT grant the trialing tier — reject through the shared
          // lost-guard handler (also used by the resubscription-reclaim branch
          // below) and return before `claimForStripe`.
          await this.rejectIneligibleTrial(
            user.id,
            subscription.id,
            manager,
            lease,
          );
          return;
        }
      }
    }

    // Same atomic-claim pattern for past_due: Stripe retries
    // `invoice.payment_failed`-driven `customer.subscription.updated`
    // events in parallel, and an in-memory `user.subscription_status
    // !== 'past_due'` check would let two handlers both pass the gate
    // and fire duplicate `subscription_billing` pushes. The
    // conditional UPDATE serialises through Postgres row-level
    // locking; loser sees affected: 0 and skips the push. Same
    // ownership + identity guards as the activation claim — and, like it,
    // this claim also writes `subscription_provider`/`stripe_subscription_id`
    // so the transition winner locks the slot and stays aligned with the
    // `claimForStripe` winner below (no split-winner dropped push).
    let wonPastDueTransition = false;
    if (newStatus === 'past_due') {
      // Same collapse as the activation claim: write ALL authoritative fields
      // so a crash right after this UPDATE leaves a complete row, and take the
      // winner signal from this single UPDATE's `affected`.
      const claim = await userRepo
        .createQueryBuilder()
        .update(User)
        .set({
          subscription_status: 'past_due',
          // Omitted while a grant is preserved (see `ownershipFields`): the
          // transition still serialises on `subscription_status != 'past_due'`,
          // so nothing depends on this claim locking ownership here.
          ...ownershipFields,
          subscription_tier: newTier,
          subscription_current_period_end: periodEnd,
          subscription_cancel_at_period_end: subscription.cancel_at_period_end,
          plan_source: planSource,
          subscription_lock_fence: lease.fenceToken,
        })
        .where('id = :id', { id: user.id })
        .andWhere("subscription_status != 'past_due'")
        .andWhere(
          "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
        )
        .andWhere(
          '(stripe_subscription_id IS NULL OR stripe_subscription_id = :sub)',
          { sub: subscription.id },
        )
        // Fence: a lease-lost stale flow can't win over a newer acquisition.
        .andWhere('subscription_lock_fence <= :fence', {
          fence: lease.fenceToken,
        })
        .execute();
      wonPastDueTransition = (claim.affected ?? 0) > 0;
    }

    // Did an activation/past_due transition UPDATE run for this event (i.e. is
    // this event's status one a transition claim owns)? When it did, that
    // single atomic UPDATE — not `claimForStripe` — is the authoritative status
    // writer for the row.
    const transitionAttempted = willActivate || newStatus === 'past_due';
    const wonTransition = wonActivationTransition || wonPastDueTransition;

    // Exclusivity claim: the race-safe writer of the core subscription row.
    // Its guard only allows the write when the row is unclaimed by another
    // provider AND its stored subscription id is null-or-equal to this event's
    // — so a Stripe event can never clobber an Apple/Google-owned row, and a
    // second concurrent session's DIFFERENT subscription id loses the race
    // instead of overwriting the current one.
    //
    // A TRANSITION WINNER SKIPS THIS FOLLOW-UP ENTIRELY. The transition UPDATE
    // above already wrote ALL authoritative fields (provider, subscription id,
    // tier, status, period end, cancel flag, plan source) atomically and locked
    // Stripe ownership of the row, so the winner owns the slot by construction
    // — `claimForStripe` would be redundant. Worse, it is an UNCONDITIONAL
    // re-write of `subscription_status` whose WHERE clause guards provider/id
    // ownership but NOT the status: a NEWER same-subscription event that
    // committed between our transition UPDATE and now (e.g. a concurrent
    // `past_due` after our `active`) would be clobbered back to our older
    // status. So the winner treats the claim as 'claimed' without re-writing.
    //
    // Only the NON-winner path runs `claimForStripe`: it is either already at
    // the target status (a period-only update / redelivery), a `canceled` event
    // (no transition owns `canceled`), or a two-session conflict. When a
    // transition was ATTEMPTED but lost (already-at-target active/trialing/
    // past_due), `skipStatus` refreshes only the current-event mutable fields
    // WITHOUT re-stamping a status a newer event may have superseded; when no
    // transition was attempted (`canceled`), `claimForStripe` stays the
    // authoritative status writer.
    let claimResult: 'claimed' | 'conflict';
    if (wonTransition) {
      // The transition UPDATE above is the authoritative status writer and has
      // ALREADY committed, so the slot is this subscription's — which
      // invalidates any open conflict filed against it just as a claim would.
      //
      // Retirement here cannot share a transaction with that write (it is
      // already durable), so it runs on the pool manager. The exposure is a
      // crash between the two leaving the row open, which is the same
      // already-accepted failure mode the drain exists to sweep — strictly
      // better than the previous behaviour, which never retired on this path at
      // all.
      claimResult = 'claimed';
      // Only when the transition actually took the slot. Under `preservesGrant`
      // its `ownershipFields` spread is empty, so it wins the status race
      // without becoming the row's owner — nothing was superseded.
      if (!preservesGrant) {
        await this.retireSupersededConflicts(manager, user.id, subscription.id);
      }
    } else {
      // The claim and the retirement of any conflict rows it invalidates run in
      // ONE transaction. A reconciliation row is a point-in-time judgement about
      // mutable state, so a claim that wins the slot for THIS subscription makes
      // any open `exclusivity_conflict` filed against it moot — and an operator
      // draining that row afterwards would refund or revoke a subscription that
      // is now the rider's valid, entitling one.
      //
      // Atomic because the alternative is worse in both directions: retiring
      // before the claim commits could close a row for a claim that then fails,
      // and retiring after could leave the row open if the process dies in
      // between. There is NO external I/O in here — both statements are local —
      // so this does not pin a pooled connection across a Stripe round trip,
      // which is the constraint that shapes the rest of this flow.
      // `userRepo.manager` is the DataSource's default manager; `.transaction()`
      // on it opens a fresh one. Deliberately NOT the pool `manager` this flow
      // was handed — that is not a transaction, and reusing it would leave the
      // two statements independently committed.
      claimResult = await this.userRepo.manager.transaction(
        async (tx: EntityManager) => {
          const result = await this.providerClaim.claimForStripe(
            user.id,
            subscription.id,
            {
              tier: newTier,
              status: newStatus,
              currentPeriodEnd: periodEnd,
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
              planSource,
              fenceToken: lease.fenceToken,
            },
            // `skipOwnership` keeps a never-entitling subscription from claiming
            // the slot out from under a preserved grant (see `ownershipFields`);
            // the WHERE guard, and therefore conflict detection, is unaffected.
            {
              skipStatus: transitionAttempted,
              skipOwnership: preservesGrant,
              manager: tx,
            },
          );
          // `claimed` alone is not enough: `skipOwnership` (the same
          // `preservesGrant` condition) returns `claimed` having deliberately
          // NOT written `stripe_subscription_id`, so the slot is untouched.
          if (result === 'claimed' && !preservesGrant) {
            await this.retireSupersededConflicts(tx, user.id, subscription.id);
          }

          return result;
        },
      );
    }

    if (claimResult === 'conflict') {
      // The exclusivity claim rejected the write, so the DB row's stored
      // subscription id differs from this event's `subscription.id`.
      // `claimForStripe`'s guard matches a same-id redelivery and returns
      // 'claimed' (idempotent same-value write), so a 'conflict' ALWAYS means a
      // genuine different-id row. That is NOT automatically a duplicate to
      // refund: it is EITHER a live duplicate (the stored subscription is still
      // active) OR a legitimate resubscription (the stored subscription already
      // ended and the incoming is the rider's real new one). We resolve which
      // below from the STORED subscription's status, never from the in-memory
      // `user.stripe_subscription_id`: in the real two-session race the loser
      // can resolve the user BEFORE the winner commits, so that snapshot is
      // stale (still null/old).
      //
      // Idempotency is guarded from DB state, not the stale snapshot: if an
      // OPEN exclusivity_conflict reconciliation already exists for THIS
      // subscription id, this is a redelivered conflict already handled →
      // skip the refund and the duplicate row (idempotent no-op).
      const alreadyHandled = await this.storeReconciliation.findOpen(
        {
          provider: 'stripe',
          reason: 'exclusivity_conflict',
          stripeSubscriptionId: subscription.id,
        },
        {},
        manager,
      );
      if (alreadyHandled.length > 0) {
        // Redelivered conflict we've already reconciled — idempotent no-op
        // (skip both the Stripe calls and a duplicate reconciliation row).
        return;
      }

      // A non-active/trialing/past_due incoming is a stale/superseded event, not
      // a live subscription: a delayed `customer.subscription.updated` for a
      // subscription Stripe has ALREADY ended (`canceled`/`incomplete_expired`/
      // `ended` — all normalized to `canceled`) also returns 'conflict', but its
      // `cancelSubscription` is a no-op while `refundOrVoidLatestInvoice` would
      // claw back a LEGITIMATE past charge. Touch NO Stripe and open no
      // reconciliation.
      const incomingLive =
        newStatus === 'active' ||
        newStatus === 'trialing' ||
        newStatus === 'past_due';
      if (!incomingLive) {
        this.logger.log(
          `Ignoring stale two-session conflict for already-ended subscription ${subscription.id} (status=${newStatus}) — no refund, no cancel`,
        );
        return;
      }

      // The correct distinguisher between a LIVE DUPLICATE and a LEGITIMATE
      // RESUBSCRIPTION is the STORED subscription's current status, NOT the
      // incoming's — the incoming is live in BOTH cases (it is either the
      // rider's real new subscription or a redundant duplicate). Gating on the
      // incoming alone mis-handles a rider whose PREVIOUS subscription ended and
      // who started a NEW Checkout before the delayed
      // `customer.subscription.deleted` cleared the STORED (old) id: the new
      // active sub conflicts with the stale stored id and would be wrongly
      // cancelled/refunded. Re-read the CURRENTLY-stored id fresh from the DB
      // (the pre-claim `user` snapshot can be stale in the two-session race),
      // then ask Stripe whether that stored subscription is still live.
      const stored = await userRepo.findOne({
        where: { id: user.id },
        select: { id: true, stripe_subscription_id: true },
      });
      const storedStaleId = stored?.stripe_subscription_id ?? null;
      // With no stored Stripe subscription id the conflict is a
      // provider-ownership conflict (an Apple/Google-owned row), NOT a
      // superseded-Stripe-id one: there is nothing to supersede, so treat the
      // incoming as a live duplicate that must not persist (round-8 behavior).
      let storedStillLive = true;
      if (storedStaleId != null) {
        const storedStatus =
          await this.stripe.getSubscriptionStatus(storedStaleId);
        storedStillLive =
          storedStatus === 'active' ||
          storedStatus === 'trialing' ||
          storedStatus === 'past_due';
      }

      // The Stripe status read above is an external round-trip during which our
      // lease could be lost. Before the reclaim/duplicate compensations + their
      // reconciliation rows, bail if a newer holder has advanced the fence past
      // us (stale flow) — a retryable 503 so a fresh flow re-decides rather than
      // cancelling/refunding or reconciling on a stale verdict.
      await assertSubscriptionFenceCurrent(userRepo, user.id, lease.fenceToken);

      if (!storedStillLive) {
        // LEGITIMATE RESUBSCRIPTION: the STORED subscription has ended/canceled/
        // missing (superseded) and Stripe has not yet cleared it via
        // `customer.subscription.deleted`. The incoming subscription is the
        // rider's REAL new one. RE-CLAIM the slot for it with a guarded UPDATE
        // that only lands while the stale id is still stored (so a concurrent
        // clear/claim can't be clobbered) and the row is not owned by another
        // provider, then proceed as a normal activation. NEVER refund/cancel the
        // incoming — it is the rider's real subscription.
        const reclaimQb = userRepo
          .createQueryBuilder()
          .update(User)
          .set({
            subscription_status: newStatus,
            // Omitted while a grant is preserved (see `ownershipFields`). The
            // slot then keeps pointing at the stale, already-dead subscription
            // this reclaim targeted, which is harmless: a terminal event for
            // THAT id also finds no Stripe-owned row. Reachable only for a raw
            // `unpaid` incoming, the one non-entitling status that is still
            // `incomingLive`.
            ...ownershipFields,
            subscription_tier: newTier,
            subscription_current_period_end: periodEnd,
            subscription_cancel_at_period_end:
              subscription.cancel_at_period_end,
            plan_source: planSource,
            subscription_lock_fence: lease.fenceToken,
            // First-trial stamp on the reclaim path: this branch RETURNS before
            // the orthogonal `userRepo.update(user.id, update)` below, so a
            // replacement subscription that carried a trial would otherwise
            // leave the rider `trial_eligible` despite having consumed one. Fold
            // the SAME first-trial marker the normal activation path computes
            // into this reclaim UPDATE — the STAMP flag, so a trial that already
            // converted to `active` before this delayed delivery still counts.
            // COALESCE preserves an already-set stamp (never re-dates it) and is
            // a no-op when the `billing_trial_used_at IS NULL` guard below
            // rejects the write outright.
            ...(consumedIntroTrial
              ? {
                  billing_trial_used_at: trialMarkerStamp(),
                }
              : {}),
          })
          .where('id = :id', { id: user.id })
          .andWhere('stripe_subscription_id = :staleSub', {
            staleSub: storedStaleId,
          })
          .andWhere(
            "(subscription_provider IS NULL OR subscription_provider = 'stripe')",
          )
          // Fence: a lease-lost stale flow can't reclaim over a newer acquisition.
          .andWhere('subscription_lock_fence <= :fence', {
            fence: lease.fenceToken,
          });
        // FINDING (round 26): guard the RECLAIM trialing GRANT on the SAME
        // current-eligibility invariant round 25 applied to the normal
        // activation transition above. Without this, a rider whose
        // `billing_trial_used_at` is already set still had the tier GRANTED
        // here (the SET above merely skipped re-dating the marker) — bypassing
        // both the normal path's eligibility guard and its lost-guard rejection,
        // letting a delayed resubscription checkout mint a SECOND trial.
        if (isTrialActivation) {
          reclaimQb.andWhere(TRIAL_ELIGIBLE_PREDICATE);
        }
        const reclaimed = await reclaimQb.execute();

        if ((reclaimed.affected ?? 0) > 0) {
          // Dispatch the confirmation only when the re-claim actually landed
          // and the incoming is an activation. Same fire-and-forget contract as
          // the normal activation dispatch below.
          if (willActivate) {
            // Reassert the lease before enqueuing (see the activation enqueue
            // below) — never confirm over a newer holder's committed state.
            await lease.assertHeld();
            const generation = await this.nextNotifyGeneration(
              user.id,
              manager,
              lease.fenceToken,
            );
            await this.enqueueSubscriptionNotification({
              kind: 'confirmed',
              userId: user.id,
              tier: newTier,
              periodEnd: periodEnd?.toISOString() ?? null,
              generation,
              source: { provider: 'stripe', identity: subscription.id },
            });
          }
          // The reclaim is a winning activation, so it must run the SAME
          // post-claim `deletion_scheduled_at` re-read the normal-activation
          // winner runs: a replacement subscription that activates AFTER
          // deletion was scheduled would otherwise renew/recharge on a
          // deleted/locked account with no cancel work item ever opened.
          await this.ensureDeletionCancelReconciliation(
            user.id,
            subscription.id,
            manager,
          );
          // The Stripe side changed (a reclaimed, future-billing
          // subscription), so the rider's provisional-overlap set must be
          // re-derived against their chains — same call as the other settle
          // points, a no-op for the chainless. A reclaim is by definition an
          // entitling activation, never terminal.
          await this.storeChainWriter.syncOverlapsAfterBillingChange(
            manager,
            user.id,
            {
              subscriptionId: subscription.id,
              createdAt: new Date(subscription.created * 1000),
              terminal: false,
            },
          );
          return;
        }

        // The reclaim affected ZERO rows. Before compensating, RE-READ the
        // currently-stored row to distinguish three very different causes
        // (widened select: the trial-eligibility check below needs
        // `billing_trial_used_at`/`subscription_provider`/`subscription_status`
        // alongside the id).
        const postReclaim = await userRepo.findOne({
          where: { id: user.id },
          select: {
            id: true,
            subscription_status: true,
            subscription_provider: true,
            stripe_subscription_id: true,
            billing_trial_used_at: true,
          },
        });

        // CAUSE 1 (round 26): the rider's `billing_trial_used_at` was already
        // set — the reclaim's own `billing_trial_used_at IS NULL` guard is what
        // rejected the write, NOT a stale-id race. Detected by the slot STILL
        // holding the stale id this UPDATE targeted (a real race would have
        // moved it to either this incoming id or a foreign one). Reject through
        // the SAME shared handler the normal activation path uses: never grant,
        // cancel + reconcile instead.
        //
        // FINDING (round 27): "already live for the rider" must be keyed on the
        // INCOMING subscription's identity, NOT the stored row's status. When the
        // stale subscription has ended at Stripe but its terminal
        // `customer.subscription.deleted` webhook is DELAYED, `postReclaim` can
        // legitimately still show `active`/`trialing` under `storedStaleId`. A
        // bare status check would then call the OLD subscription "already live",
        // suppress this ineligible-trial branch, and fall through to the
        // exclusivity path — which wrongly cancels/refunds the charge-free
        // incoming trial. So "already live" means the row is owned by THIS
        // incoming subscription id in a live state (the incoming trial already
        // won a concurrent delivery — CAUSE 2's shape); a stale-id row is NOT
        // live for the incoming purchase.
        if (
          isTrialActivation &&
          this.isIneligibleTrialRejection(postReclaim, {
            isAlreadyLiveForRider: (row) =>
              row.stripe_subscription_id === subscription.id &&
              (row.subscription_status === 'active' ||
                row.subscription_status === 'trialing'),
            isClaimableSlot: (row) =>
              (row.subscription_provider == null ||
                row.subscription_provider === 'stripe') &&
              row.stripe_subscription_id === storedStaleId,
          })
        ) {
          await this.rejectIneligibleTrial(
            user.id,
            subscription.id,
            manager,
            lease,
          );
          return;
        }

        // CAUSE 2: two concurrent deliveries of the SAME incoming subscription
        // both observe the terminal stored id and enter reclaim; ONE wins the
        // guarded UPDATE (the slot now holds THIS incoming id) and the OTHER's
        // UPDATE affects 0 rows *precisely because the slot now already holds
        // this same incoming id* (its `WHERE stripe_subscription_id = :staleSub`
        // no longer matches). That loser must NOT cancel/refund — doing so
        // would claw back the subscription the winning delivery legitimately
        // just claimed.
        if (postReclaim?.stripe_subscription_id === subscription.id) {
          // A concurrent delivery of THIS SAME subscription already claimed the
          // slot — the 0-row result is that race's idempotent loser, NOT a
          // foreign-owned slot. Touch no Stripe and open no conflict. Still run
          // the (deduped, idempotent) post-claim deletion re-read so a winner
          // whose `ensureDeletionCancelReconciliation` insert failed transiently
          // gets a retry, matching the winning-reclaim path above.
          await this.ensureDeletionCancelReconciliation(
            user.id,
            subscription.id,
            manager,
          );
          return;
        }

        // CAUSE 3: the slot is owned by a DIFFERENT subscription or another
        // provider (Apple/Google retains a terminal old `stripe_subscription_id`,
        // or a concurrent clear/claim moved a different id in): a genuine intruder.
        // This is NOT a safe silent return — the incoming is a LIVE Stripe
        // subscription that never took the slot, so leaving it untouched runs a
        // Stripe sub on a foreign-owned account (cross-provider double-billing).
        // Compensate it exactly like the duplicate-loser path below: cancel +
        // refund + open an `exclusivity_conflict` (deduped by the
        // `alreadyHandled` check at the top of this branch). Fence the lease
        // (atomic check-and-extend) before EACH external write so neither can run
        // on a lease we've lost, and each gets a fresh full-TTL window.
        await lease.assertHeld();
        await this.stripe.cancelSubscription(subscription.id);
        await lease.assertHeld();
        await this.stripe.refundOrVoidLatestInvoice(subscription.id);
        await this.storeReconciliation.openConflict(
          {
            userId: user.id,
            provider: 'stripe',
            stripeSubscriptionId: subscription.id,
            reason: 'exclusivity_conflict',
            detail: {
              losingSubscriptionId: subscription.id,
              reclaimUnclaimable: true,
            },
          },
          manager,
        );
        return;
      }

      // GENUINE DUPLICATE: the STORED subscription is still live, so the
      // incoming is a second, redundant subscription. Cancel AND refund it — a
      // refund alone leaves it ACTIVE to renew, recharge the rider, and keep
      // emitting conflicting webhooks, so the immediate `cancelSubscription`
      // (not `cancel_at_period_end`) is correct. It tolerates `resource_missing`,
      // so a redelivery that races an out-of-band cancel is idempotent; the
      // `findOpen` dedup above already skips both calls on a reconciled
      // redelivery. Fence the lease (atomic check-and-extend) before EACH
      // external write — never compensate on a lost lease, and each op gets a
      // fresh full-TTL window.
      await lease.assertHeld();
      await this.stripe.cancelSubscription(subscription.id);
      await lease.assertHeld();
      await this.stripe.refundOrVoidLatestInvoice(subscription.id);
      await this.storeReconciliation.openConflict(
        {
          userId: user.id,
          provider: 'stripe',
          stripeSubscriptionId: subscription.id,
          reason: 'exclusivity_conflict',
          detail: {
            losingSubscriptionId: subscription.id,
          },
        },
        manager,
      );
      return;
    }

    // Fallback trial stamp ONLY for the trial paths the atomic grant UPDATE
    // above could NOT cover: a trial event that did not win the activation
    // transition (the row was already active/trialing — the winning delivery
    // already stamped atomically, so COALESCE is a no-op here), or a trial
    // subscription whose price maps to no paid tier (no activation UPDATE runs).
    // The TRIAL-GRANT winner is deliberately EXCLUDED (`wonActivationTransition`)
    // so the marker is never written in a separate, race-prone statement on the
    // grant path — that atomic fold is Finding 1's fix. COALESCE keeps this
    // fallback idempotent/monotonic, which is what makes it safe to re-fire on
    // EVERY later `updated` event of a subscription that once had a trial: an
    // existing marker is never re-dated, and a marker lost to a delayed delivery
    // (the `consumedIntroTrial` case) self-heals on the next event.
    if (consumedIntroTrial && !wonActivationTransition) {
      update.billing_trial_used_at = trialMarkerStamp();
    }

    // Flush the orthogonal fields the exclusivity claim does NOT touch (customer
    // id, updated_at, the fallback trial marker above). This payload never
    // carries `subscription_status`, so a slower handler can't overwrite the
    // status the atomic claims settled — but it IS otherwise unconditional, so it
    // must ALSO be fence-guarded ATOMICALLY (a check-then-update would race): the
    // WHERE carries `subscription_lock_fence <= :fence` and the SET restamps it,
    // so a stale handler (a newer holder already advanced the fence) matches 0
    // rows and never overwrites `stripe_customer_id` with a superseded value or
    // stamps `billing_trial_used_at` from a superseded fallback-trial event. The
    // monotonic trigger protects the fence column but NOT these other fields, so
    // the predicate must live in this same statement. A 0-row result is a benign
    // skip (the newer flow already wrote the correct orthogonal fields).
    await userRepo.update(
      {
        id: user.id,
        subscription_lock_fence: LessThanOrEqual(lease.fenceToken),
      },
      { ...update, subscription_lock_fence: lease.fenceToken },
    );

    // Dispatch is gated on BOTH the exclusivity claim (`claimResult ===
    // 'claimed'` — established above; the conflict branch already returned)
    // AND the transition claim. Because the transition claim now locks
    // ownership, its winner IS the exclusivity winner, so this AND fires for
    // exactly one handler. The explicit `claimResult` check is the belt to the
    // transition claim's braces: it also suppresses the confirmation in the
    // rare window where an Apple/Google event claims the row between the
    // status-claim and `claimForStripe` (which then returns 'conflict').
    // Reassert the lease before the winner-only notifications: `won*Transition`
    // was decided earlier, and if our lease lapsed since (a newer delivery
    // committing the opposite state), we must NOT send a stale confirmation /
    // billing-failed alert. A lost lease throws (retryable) before either send.
    if (
      (claimResult === 'claimed' && wonActivationTransition) ||
      (claimResult === 'claimed' && wonPastDueTransition)
    ) {
      await lease.assertHeld();
    }
    if (claimResult === 'claimed' && wonActivationTransition) {
      // Enqueue for durable, out-of-lock delivery (see the cancellation path
      // above) instead of an inline send — keeps the webhook response well inside
      // Stripe's 20s window and lets the consumer drop a confirmation whose
      // generation/state a newer event (e.g. an immediate cancellation) has
      // superseded.
      const generation = await this.nextNotifyGeneration(
        user.id,
        manager,
        lease.fenceToken,
      );
      await this.enqueueSubscriptionNotification({
        kind: 'confirmed',
        userId: user.id,
        tier: newTier,
        periodEnd: periodEnd?.toISOString() ?? null,
        generation,
        source: { provider: 'stripe', identity: subscription.id },
      });
    }

    if (claimResult === 'claimed' && wonPastDueTransition) {
      const generation = await this.nextNotifyGeneration(
        user.id,
        manager,
        lease.fenceToken,
      );
      await this.enqueueSubscriptionNotification({
        kind: 'billing_failed',
        userId: user.id,
        generation,
        source: { provider: 'stripe', identity: subscription.id },
      });
    }

    // If this activation lands on an account already SCHEDULED for deletion, the
    // deletion request that stamped `deletion_scheduled_at` ran BEFORE this
    // subscription became visible on the row — so `requestDeletion` captured a
    // null subscription id and opened no cancel-flag work item. Ensure a durable
    // `deletion_cancel_failed` reconciliation exists now (deduped on any
    // already-open row for this subscription, like the exclusivity-conflict
    // path): the lock-guarded worker will re-read the still-set
    // `deletion_scheduled_at` and `setCancelAtPeriodEnd(true)`, so a
    // newly-activated subscription can't keep renewing/charging a rider whose
    // account is locked for deletion. Run on EVERY activation delivery that OWNS
    // this subscription (`claimResult === 'claimed'` + `willActivate`), NOT only
    // the transition winner: if the winner's insert failed transiently AFTER its
    // activation UPDATE committed, Stripe redelivers with
    // `wonActivationTransition=false` (the row is already active) — a
    // winner-only gate would then never retry and a locked/deleting account
    // would keep a renewable subscription. The `findOpen` dedup inside keeps a
    // redelivery idempotent when the row already exists, and the fresh
    // `deletion_scheduled_at` re-read keeps it cheap (a SELECT that returns early
    // on non-deleting accounts, which is the overwhelmingly common case).
    if (claimResult === 'claimed' && willActivate) {
      await this.ensureDeletionCancelReconciliation(
        user.id,
        subscription.id,
        manager,
      );
    }

    // The Stripe side settled (activation, past_due, cancel-flag or period
    // refresh) — re-derive the rider's provisional-overlap set against their
    // chains. Creation and retirement share one `futureBilling` reading, so a
    // Stripe activation beside a live chain records the overlap (the ingestion
    // race the server-side check exists to catch), and a cancel-at-period-end
    // retires it. Idempotent, and a no-op for the chainless — every rider
    // until the step-5 consumer ships. `terminal` restates this event's own
    // normalized lifecycle claim — redundant with the row THIS handler just
    // persisted, but it keeps the record honest about what kind of
    // observation it is if the persistence path above ever changes shape.
    await this.storeChainWriter.syncOverlapsAfterBillingChange(
      manager,
      user.id,
      {
        subscriptionId: subscription.id,
        createdAt: new Date(subscription.created * 1000),
        terminal:
          this.statusFromSubscription(subscription.status) === 'canceled',
      },
    );
  }

  // FINDING 2 (round 25) / FINDING (round 26): shared predicate for the
  // lost-trial-guard case. Both the normal activation transition and the
  // resubscription reclaim guard their `trialing` GRANT on
  // `billing_trial_used_at IS NULL`. When that guarded UPDATE affects 0 rows,
  // each call site re-reads the row fresh and must distinguish the INELIGIBLE
  // shape (the marker is already set, the row is not already live for the
  // rider, and the slot is otherwise still claimable by this event) from its
  // own benign 0-row losers (a concurrent delivery that already won, or a
  // genuine cross-provider/different-id conflict its own path already
  // handles). Only the ineligible shape must reject instead of granting —
  // factored out so the two call sites can't drift out of sync on what
  // "ineligible" means.
  private isIneligibleTrialRejection(
    fresh: TrialGuardRow | null,
    opts: {
      isAlreadyLiveForRider: (row: TrialGuardRow) => boolean;
      isClaimableSlot: (row: TrialGuardRow) => boolean;
    },
  ): boolean {
    if (!fresh) {
      return false;
    }
    const markerAlreadySet = fresh.billing_trial_used_at != null;
    return (
      markerAlreadySet &&
      !opts.isAlreadyLiveForRider(fresh) &&
      opts.isClaimableSlot(fresh)
    );
  }

  // The rejection side effects for a lost trial-eligibility guard, shared by
  // BOTH the normal activation-transition path and the resubscription-reclaim
  // path: cancel the (charge-free) trial via the reversible P0 cancel and open
  // a deduped `ineligible_trial_rejected` reconciliation for ops. Never a
  // refund — a trial has no charge yet, unlike the exclusivity-conflict path.
  // Deduped like that path: a redelivered ineligible trial already reconciled
  // is an idempotent no-op (skips both the Stripe cancel and a duplicate
  // reconciliation row).
  private async rejectIneligibleTrial(
    userId: string,
    subscriptionId: string,
    manager: EntityManager,
    lease: SubscriptionLockLease,
  ): Promise<void> {
    // This runs when a guarded trial-grant UPDATE affected 0 rows. If that 0-row
    // was actually a STALE FENCE (a newer holder advanced past us), rejecting the
    // trial here would open a spurious `ineligible_trial_rejected` reconciliation
    // and cancel a valid trial. Bail with a retryable 503 first so a fresh flow
    // re-decides.
    await assertSubscriptionFenceCurrent(
      manager.getRepository(User),
      userId,
      lease.fenceToken,
    );
    const alreadyHandled = await this.storeReconciliation.findOpen(
      {
        provider: 'stripe',
        reason: 'ineligible_trial_rejected',
        stripeSubscriptionId: subscriptionId,
      },
      {},
      manager,
    );
    if (alreadyHandled.length === 0) {
      // Fence the external write on the lock (never cancel on a lost lease).
      await lease.assertHeld();
      await this.stripe.setCancelAtPeriodEnd(subscriptionId, true);
      await this.storeReconciliation.openConflict(
        {
          userId,
          provider: 'stripe',
          stripeSubscriptionId: subscriptionId,
          reason: 'ineligible_trial_rejected',
        },
        manager,
      );
    }
  }

  // After WINNING a Stripe activation/reclaim, re-read the CURRENT
  // `deletion_scheduled_at` and, if the account is scheduled for deletion, open
  // a deduped `deletion_cancel_failed` reconciliation so the lock-guarded worker
  // cancels the subscription. Shared by BOTH the normal-activation winner and
  // the resubscription reclaim winner: a replacement subscription that activates
  // AFTER deletion was scheduled must open the same work item, or it renews and
  // recharges a rider whose account is locked for deletion with no work item
  // ever opened.
  private async ensureDeletionCancelReconciliation(
    userId: string,
    subscriptionId: string,
    manager: EntityManager,
  ): Promise<void> {
    // RE-READ the CURRENT `deletion_scheduled_at` from the DB rather than
    // trusting the pre-claim `user` snapshot. Race: this webhook can resolve
    // `user` with `deletion_scheduled_at = null` just before `requestDeletion`
    // locks and stamps the row; our winning activation UPDATE then WAITS on
    // that row lock, the deletion transaction commits (sees no subscription,
    // opens no cancel work item), and only then does our claim win. The stale
    // pre-claim snapshot still shows null and would skip this gate, leaving a
    // renewable subscription on a deleting account. Because the winning claim
    // UPDATE serializes against `requestDeletion`'s users-row write, this
    // post-claim SELECT reflects any deletion that committed while the claim
    // was waiting.
    const fresh = await manager.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true, deletion_scheduled_at: true },
    });
    if (fresh?.deletion_scheduled_at == null) return;
    const alreadyOpen = await this.storeReconciliation.findOpen(
      {
        provider: 'stripe',
        reason: 'deletion_cancel_failed',
        stripeSubscriptionId: subscriptionId,
      },
      {},
      manager,
    );
    if (alreadyOpen.length > 0) return;
    await this.storeReconciliation.openConflict(
      {
        userId,
        provider: 'stripe',
        stripeSubscriptionId: subscriptionId,
        reason: 'deletion_cancel_failed',
        detail: {
          subscriptionId,
          opened: 'activated_during_deletion',
        },
      },
      manager,
    );
  }

  private async findUserForSubscriptionEvent(
    customerId: string | null,
    userId: string | null,
  ): Promise<User | null> {
    if (customerId) {
      const byCustomer = await this.userRepo.findOne({
        where: { stripe_customer_id: customerId },
      });
      if (byCustomer) return byCustomer;
    }

    if (userId) {
      return this.userRepo.findOne({ where: { id: userId } });
    }

    return null;
  }

  private buildSubscriptionSnapshot(
    user: User,
    liveSnapshot: StripeBillingSnapshot | null,
    /** The rider's chains that still entitle — see `loadLiveChains`. */
    liveChains: readonly StoreSubscription[],
  ): SubscriptionSnapshotResponseDto {
    // The live plan's `tier` is the BILLED PRODUCT (derived from the price
    // alone), so it may name a paid tier the rider is not entitled to — a
    // subscription gone `unpaid` still carries the Pro/Premium price. Reporting
    // it here made `GET /account/subscription` (and the companion's "Included
    // right now" list) claim paid features while `FeatureResolverService`
    // correctly denied them from the persisted tier. Trust the live tier ONLY
    // while it currently entitles; otherwise fall back to the STORED tier,
    // which is the same value the resolver enforces — correct in both
    // directions, because ingestion has already persisted `free` for a billed
    // subscription that stopped entitling, and a founder/promo/admin grant
    // keeps the tier it was granted (grants deliberately carry a paid tier with
    // a `canceled` status, so this must never become a status gate).
    //
    // Status/renewal/cancel-flag intentionally keep preferring the live values:
    // they describe the BILLED PRODUCT, which is exactly what the billing
    // screen's status chip, renewal line and invoice list are reporting.
    const livePlan = liveSnapshot?.currentPlan ?? null;

    // TWO QUESTIONS, and only the second is an election.
    //
    // `current_plan.tier` answers "what is the rider entitled to?" and is the
    // RESOLVED tier, grant included — the same value enforcement uses.
    // Collapsing it into the election breaks grants: a Premium grant beside a
    // live Pro subscription has no Premium source to elect, so the projection
    // would show a weaker plan than the backend actually grants. That is
    // invisible today only because grants are still written into
    // `subscription_tier`; taking the resolved value now rather than inheriting
    // the coincidence is what survives #1132 stage 3.
    // The store side comes from the LIVE CHAINS, not the rollup — same value in
    // the steady state, and correct during a rollover the rollup has not caught
    // up with.
    const storeTier = liveChains.reduce<StoreTier | null>(
      (best, chain) =>
        best == null || higherTier(best, chain.tier) === chain.tier
          ? chain.tier
          : best,
      null,
    );
    const currentTier = resolveEntitledTier({
      grant_tier: user.grant_tier,
      subscription_tier: livePlan?.entitling
        ? livePlan.tier
        : user.subscription_tier,
      store_subscription_tier: storeTier,
      // Already filtered to live chains, so the expiry check has nothing left to
      // do — a far-future sentinel keeps the shared resolver's contract without
      // inventing a date the response could ever show.
      store_subscription_tier_expires_at:
        storeTier == null ? null : new Date(8.64e15),
    });

    // Everything else answers "who manages the billing behind it?" — one live
    // source is elected and the management fields come from it. Without this
    // there is no rule for which of two live chains drives the management link
    // or the displayed renewal.
    const liveSources = [
      // Stripe joins only while it actually entitles, matching the tier rule
      // above: an `unpaid` subscription still carries a paid price, and letting
      // it win the election would point the rider at a plan they have lost.
      // `entitling` is not enough on its own: a subscription on a deleted or
      // unrecognised price is active and entitling while priceToTier() maps it
      // to `free`. Coercing that to a paid tier invents a source, which can then
      // WIN the election over a real store chain on period end or provider rank
      // — reporting a store-funded plan as Stripe-managed. A source that
      // contributes no tier does not belong in an election about tiers.
      ...(livePlan?.entitling && livePlan.tier !== 'free'
        ? [
            {
              provider: 'stripe' as const,
              // The SNAPSHOT's selected id, not the stored column: a legacy
              // customer-only rider has a null `stripe_subscription_id` while
              // the snapshot still discovered their entitling subscription, and
              // an empty-string identity would make the election's final
              // tie-break undefined for exactly them (#1191 item 8).
              identity: livePlan.id,
              tier: livePlan.tier,
              status: livePlan.status,
              currentPeriodEnd: livePlan.renewsAt
                ? new Date(livePlan.renewsAt)
                : (user.subscription_current_period_end ?? null),
              cancelAtPeriodEnd:
                livePlan.cancelAtPeriodEnd ??
                user.subscription_cancel_at_period_end,
            },
          ]
        : []),
      ...liveChains.map((chain) => ({
        provider: chain.provider,
        identity: chain.target_key,
        tier: chain.tier,
        status: chain.status,
        currentPeriodEnd: chain.current_period_end,
        cancelAtPeriodEnd: chain.cancel_at_period_end,
      })),
    ];
    const representative = electRepresentative(liveSources);

    // Cancellation is a question about BILLING, not about tiers, so it is
    // aggregated over a different set. A Stripe subscription on a deleted or
    // unrecognised price is rightly barred from the election — it contributes no
    // tier to elect — but it is still charging the rider, so letting the
    // election's candidate list drive `every()` reported "your plan is ending"
    // while Stripe went on billing. That is the same misconfiguration producing
    // a billing surprise instead of a display bug.
    const liveBilling: { cancelAtPeriodEnd: boolean }[] = [
      // NOT gated on `entitling`. An `unpaid` subscription still exists and can
      // still be renewing — Stripe reports it with entitling false because it
      // grants nothing, which is the right answer for tiers and the wrong one
      // for "is this still billing?". Only a terminal status removes it.
      ...(livePlan != null && livePlan.status !== 'canceled'
        ? [
            {
              cancelAtPeriodEnd:
                livePlan.cancelAtPeriodEnd ??
                user.subscription_cancel_at_period_end,
            },
          ]
        : []),
      ...liveChains.map((chain) => ({
        cancelAtPeriodEnd: chain.cancel_at_period_end,
      })),
    ];

    const currentStatus =
      representative?.status ?? livePlan?.status ?? user.subscription_status;
    // Store-managed riders (Apple/Google) must never be routed into the
    // Stripe billing portal, even if a lingering `stripe_customer_id` from a
    // prior Stripe touch survives on the row. The portal is Stripe-only;
    // gate `portal_available` on provider so the contract itself is
    // safe-by-default rather than relying on each client to re-check.
    // Store-managed is now a question about the ELECTED source, not the column:
    // `subscription_provider` is single-valued, so it cannot say who manages
    // billing for a rider holding both sides. Routing such a rider into the
    // Stripe portal on the strength of a lingering customer id is what this
    // gate exists to prevent, and the representative is the only thing that
    // knows which side actually won.
    // Only a STORE representative overrides the column here, and that asymmetry
    // is deliberate. A legacy row — a Stripe customer id with a null
    // `subscription_provider`, from before that column existed — reports a null
    // provider on purpose: it means "not recorded", and electing `stripe` for
    // it would change what today's riders see in a change that is otherwise
    // dark. A chain, by contrast, is only ever created by the store writers, so
    // deferring to it cannot alter any existing row.
    // A Stripe side exists if Stripe is currently billing or has a subscription
    // on record — not merely a customer id, which survives a one-off touch.
    const hasStripeSide =
      livePlan != null || user.stripe_subscription_id != null;
    const storeRepresentative =
      representative?.provider === 'apple' ||
      representative?.provider === 'google'
        ? representative
        : null;
    const slotClaimsStore =
      user.subscription_provider === 'apple' ||
      user.subscription_provider === 'google';
    const electedProvider =
      storeRepresentative != null || (slotClaimsStore && representative != null)
        ? representative?.provider
        : undefined;
    // Store-managed follows the ELECTED provider once anything was elected, so a
    // rider whose Stripe side won is not treated as store-managed on the
    // strength of a slot the election has already contradicted.
    const isStoreManaged =
      electedProvider != null
        ? electedProvider === 'apple' || electedProvider === 'google'
        : slotClaimsStore;
    return {
      current_plan: {
        tier: currentTier,
        status: currentStatus,
        // "The representative has an UNKNOWN end" and "there is no
        // representative" are different answers, and `??` collapses them. A
        // higher-tier store chain can legitimately win with a null period end,
        // and chaining past it reported the LOSING Stripe source's renewal date
        // as the Apple/Google plan's — a real date, belonging to a different
        // subscription, which is worse than the blank it replaced.
        //
        // The legacy fallback applies only when nothing was elected: a grant or
        // a lapsed plan, where the rider still sees the date their access runs
        // to.
        renews_at: representative
          ? (representative.currentPeriodEnd?.toISOString() ?? null)
          : (livePlan?.renewsAt ??
            user.subscription_current_period_end?.toISOString() ??
            null),
        // TRUE only when EVERY live source is ending. Copying the
        // representative's flag tells a rider with two subscriptions that their
        // billing stops while the other one keeps renewing — a billing surprise
        // in the direction that costs them money, and the opposite of what the
        // flag is read for. With no live source at all this falls back to the
        // legacy columns, which is what a grant-only or lapsed rider still sees.
        cancel_at_period_end:
          liveBilling.length > 0
            ? liveBilling.every((source) => source.cancelAtPeriodEnd)
            : (livePlan?.cancelAtPeriodEnd ??
              user.subscription_cancel_at_period_end),
      },
      // A tier is the stable display-content identifier. Localized names,
      // features, descriptions and prices belong to each client catalog, not
      // this locale-neutral API response.
      plans: SUBSCRIPTION_TIERS.map((tier) => ({ tier })),
      payment_method: liveSnapshot?.paymentMethod
        ? {
            brand: liveSnapshot.paymentMethod.brand,
            last4: liveSnapshot.paymentMethod.last4,
            exp_month: liveSnapshot.paymentMethod.expMonth,
            exp_year: liveSnapshot.paymentMethod.expYear,
          }
        : null,
      billing_history:
        liveSnapshot?.invoices.map((invoice) => ({
          id: invoice.id,
          date: invoice.date,
          amount_label: invoice.amountLabel,
          amount_minor: invoice.amountMinor,
          currency: invoice.currency,
          status: invoice.status,
          invoice_url: invoice.invoiceUrl,
        })) ?? [],
      // Reachable whenever a STRIPE SIDE EXISTS, independent of who won the
      // election. A rider holding both sides would otherwise have their
      // still-billing Stripe subscription stranded the moment a store chain
      // took the representative slot — unable to cancel the thing charging
      // them, which is a worse failure than showing an extra link and the same
      // one the checkout kill switch is deliberately not allowed to cause.
      //
      // The original gate survives where it still applies: a store-managed
      // rider whose only Stripe trace is a lingering customer id from a prior
      // touch has no Stripe side, so the portal stays hidden for them.
      portal_available:
        Boolean(user.stripe_customer_id) && (hasStripeSide || !isStoreManaged),
      // The representative wins whenever EITHER side is store-flavoured — a
      // store source was elected, or the legacy slot claims a store while
      // something else actually won. The second half is the case that matters
      // here: Stripe Premium beside an Apple Pro chain elects Stripe, and
      // reporting the slot's `apple` alongside Stripe's status and renewal hands
      // the companion store provenance for a Stripe plan, so it swaps in the
      // wrong management panel entirely.
      //
      // Still NOT "any representative", deliberately. A legacy row — Stripe
      // customer id with a null provider — reports null on purpose, meaning
      // "not recorded", and electing `stripe` for it would change what today's
      // riders see in a change that is otherwise dark. Chains cannot create that
      // case, so this stays behaviour-neutral until the writers land.
      provider: electedProvider ?? user.subscription_provider,
      managed_by: electedProvider
        ? managedByForProvider(electedProvider)
        : user.subscription_provider
          ? managedByForProvider(user.subscription_provider)
          : null,
      trial_eligible: user.billing_trial_used_at == null,
    };
  }

  /** The rollup pair alone — never selected onto an entity that gets saved. */
  private async loadStoreRollup(userId: string): Promise<StoreRollup> {
    const row = await this.userRepo.findOne({
      where: { id: userId },
      select: {
        id: true,
        store_subscription_tier: true,
        store_subscription_tier_expires_at: true,
      },
    });
    return {
      store_subscription_tier: row?.store_subscription_tier ?? null,
      store_subscription_tier_expires_at:
        row?.store_subscription_tier_expires_at ?? null,
    };
  }

  private async getUserById(userId: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private priceIdForTier(tier: Exclude<BillingTier, 'free'>): string {
    const envKey =
      tier === 'premium'
        ? 'TARMOTO_STRIPE_PREMIUM_PRICE_ID'
        : 'TARMOTO_STRIPE_PRO_PRICE_ID';
    const priceId = this.config.get<string>(envKey)?.trim();
    if (!priceId) {
      throw new BadRequestException(
        `Billing price for ${tier} is not configured`,
      );
    }
    return priceId;
  }

  private subscriptionPageUrl(): string {
    return `${getCompanionUrl(this.config)}/settings/subscription`;
  }

  private isIntroTrialEligible(user: User): boolean {
    return user.billing_trial_used_at == null;
  }

  private tierFromPrice(
    price: StripeSubscription['items']['data'][number]['price'] | undefined,
  ): BillingTier {
    if (!price || ('deleted' in price && price.deleted)) return 'free';

    // Configured price IDs are checked BEFORE lookup keys: the env vars
    // are per-environment and under our control, while Stripe lookup
    // keys may still carry the pre-swap (2026-07) name↔price pairing.
    // With correctly re-pointed env vars, a stale lookup key can no
    // longer flip a paid user onto the wrong tier.
    const premiumPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PREMIUM_PRICE_ID')?.trim() ??
      null;
    const proPriceId =
      this.config.get<string>('TARMOTO_STRIPE_PRO_PRICE_ID')?.trim() ?? null;
    if (proPriceId && price.id === proPriceId) return 'pro';
    if (premiumPriceId && price.id === premiumPriceId) return 'premium';

    if (price.lookup_key === 'pro') return 'pro';
    if (price.lookup_key === 'premium') return 'premium';

    // Nothing matched. Returning `free` here is the safe direction — an unknown
    // price must never entitle — but it is ALSO exactly what a misconfigured
    // environment looks like: the rider is billed by Stripe and granted
    // nothing, silently. That is the worst-shaped config error there is, so it
    // must be loud.
    //
    // Reached in two very different situations: a genuinely unpriced/unmapped
    // product (fine), or `TARMOTO_STRIPE_{PRO,PREMIUM}_PRICE_ID` pointing at
    // the wrong prices while the Stripe lookup keys are also unset (not fine).
    // The log names the price so the second is diagnosable from one line.
    this.logger.error(
      `Stripe price ${price.id} (lookup_key=${String(price.lookup_key)}) maps to NO tier — ` +
        `the rider is being billed and entitled nothing. Check TARMOTO_STRIPE_PRO_PRICE_ID / ` +
        `TARMOTO_STRIPE_PREMIUM_PRICE_ID and the price's lookup_key in Stripe.`,
    );
    return 'free';
  }

  private statusFromSubscription(status: string): BillingStatus {
    if (status === 'trialing') return 'trialing';
    if (status === 'past_due' || status === 'unpaid') return 'past_due';
    if (status === 'active') return 'active';
    return 'canceled';
  }
}

function subscriptionPeriodEnd(
  subscription: StripeSubscription,
): number | null {
  const ends = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');
  if (ends.length === 0) return null;
  return Math.max(...ends);
}
