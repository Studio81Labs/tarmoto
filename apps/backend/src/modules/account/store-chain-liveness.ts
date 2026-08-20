/**
 * The THREE liveness rules of the store-chains design, defined once.
 *
 * The design is explicit that these must be one definition, not three: the live
 * rule (entitlement), the rollup expiry and `futureBilling` (overlap creation
 * and retirement) all substitute the SAME bounded fallback for a null period
 * end, "so all three agree on one definition rather than three". A chain that
 * stops entitling at one boundary in the resolver and a different one in the
 * snapshot — or that keeps forming overlap pairs after it stopped counting as
 * live — is exactly the drift this module exists to prevent.
 *
 * Design: `docs/superpowers/specs/2026-08-12-store-subscription-chains-design.md`.
 */

/**
 * A source's EFFECTIVE period end: its known end, or the bounded fallback for a
 * null one.
 *
 * A null period end means "no known end", never "no end": treating it as
 * expired denies a paying rider, treating it as eternal grants forever on a
 * lost terminal. The fallback is anchored on the LAST OBSERVATION — not on
 * `created_at`, which would leave a chain re-observed later than the window
 * carrying an already-expired bound while it is demonstrably still being
 * observed.
 */
export function effectivePeriodEnd(
  currentPeriodEnd: Date | null,
  observedAt: Date,
  fallbackWindowMs: number,
): Date {
  return currentPeriodEnd ?? new Date(observedAt.getTime() + fallbackWindowMs);
}

/** The period shape shared by every liveness question below. */
export interface SourcePeriod {
  currentPeriodEnd: Date | null;
  /** When the source was last observed (`store_signed_date` for a chain). */
  observedAt: Date;
}

/**
 * Does this source still ENTITLE? The period decides, never the status.
 *
 * `past_due` entitles (billing retry), and `canceled` entitles until the period
 * ends — a status allowlist revokes access the instant a rider cancels, from a
 * period they already paid for. Immediate revocation is expressed upstream by
 * TRUNCATING the period, so this one predicate covers both endings.
 */
export function isSourceLive(
  period: SourcePeriod,
  now: Date,
  fallbackWindowMs: number,
): boolean {
  return (
    effectivePeriodEnd(
      period.currentPeriodEnd,
      period.observedAt,
      fallbackWindowMs,
    ).getTime() > now.getTime()
  );
}

/** What `futureBilling` needs to know about a source, beyond its period. */
export interface FutureBillingSourceState extends SourcePeriod {
  /**
   * The source has reached a terminal lifecycle state (cancelled, expired,
   * revoked). For a chain that is `status === 'canceled'`; for the persisted
   * Stripe side, `subscription_status === 'canceled'`.
   */
  terminal: boolean;
  cancelAtPeriodEnd: boolean;
}

/**
 * Will this source CHARGE AGAIN? One named predicate, shared by overlap
 * creation and retirement — the design's rule is that they must test the same
 * thing "or rows appear that nothing can clear".
 *
 * NOT the same question as {@link isSourceLive}: a source cancelled mid-period
 * keeps entitling to its period end while it will never charge again. An
 * overlap is a statement about two sources that will both KEEP charging, so
 * the moment one is terminal, or has `cancel_at_period_end` set, or its
 * effective period has passed, there is no future double-charge — whatever
 * access the rider retains for the period they already paid for.
 *
 * The `cancelAtPeriodEnd` clause is the one a status-based implementation
 * drops: a Stripe subscription sitting at `active` with the flag set is still
 * entitling and still non-terminal, but its retiring event has ALREADY fired —
 * pairing it creates a row nothing can clear.
 */
export function isFutureBilling(
  source: FutureBillingSourceState,
  now: Date,
  fallbackWindowMs: number,
): boolean {
  if (source.terminal) return false;
  if (source.cancelAtPeriodEnd) return false;
  return isSourceLive(source, now, fallbackWindowMs);
}

/**
 * The live-chain predicate as SQL, for queries that must filter in the
 * database (`store_subscriptions` rows only).
 *
 * A rider who changes base plan repeatedly accumulates one row per chain and
 * nothing prunes them, so filtering in JavaScript would scale a request with
 * their lifetime purchase history. Callers bind `:liveNow` (the evaluation
 * instant) and `:liveCutoff` (`liveNow - fallback window`): a null-period chain
 * is live while `store_signed_date > :liveCutoff`, the same bound
 * {@link isSourceLive} applies, so the SQL and TypeScript spellings cannot
 * disagree about which chains count.
 */
export const LIVE_CHAIN_SQL = (alias: string): string => `
  (${alias}.current_period_end > :liveNow
   OR (${alias}.current_period_end IS NULL
       AND ${alias}.store_signed_date > :liveCutoff))`;

/** The parameter pair {@link LIVE_CHAIN_SQL} binds, derived from one instant. */
export function liveChainParams(
  now: Date,
  fallbackWindowMs: number,
): { liveNow: Date; liveCutoff: Date } {
  return {
    liveNow: now,
    liveCutoff: new Date(now.getTime() - fallbackWindowMs),
  };
}
