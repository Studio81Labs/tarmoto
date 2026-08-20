import type { SubscriptionProvider } from '@tarmoto/shared';
import { effectivePeriodEnd } from './store-chain-liveness.js';

/**
 * Pure helpers for the provisional-overlap pair machinery on
 * `store_billing_reconciliations`.
 *
 * An overlap is an UNORDERED PAIR of provider-qualified source identities. The
 * encoding, the low/high canonicalisation, the refund-target role and the
 * escalation deadline are all rules the schema enforces the shape of
 * (migration 1837's `sbr_overlap_*` CHECKs) but cannot compute — so they live
 * here, in one place, for the claim writers, the Stripe webhook path and the
 * deadline sweep to share.
 *
 * Design: `docs/superpowers/specs/2026-08-12-store-subscription-chains-design.md`
 * → "Cross-provider exclusivity — the rule that changes".
 */

/**
 * One billing source as the overlap machinery sees it.
 *
 * `identity` is the Stripe subscription id or the chain's `target_key` — the
 * chain's `original_transaction_id` cannot be used, because an unidentified
 * chain has none and a pair built on it could not be constructed at all.
 */
export interface OverlapMember {
  provider: SubscriptionProvider;
  identity: string;
  currentPeriodEnd: Date | null;
  /** When the source was last observed — the null-period fallback anchor. */
  observedAt: Date;
  /**
   * The STORE's own purchase chronology (`original_purchase_date`, or Stripe's
   * `created`), which decides the refund-target role. Null when the source did
   * not supply one — the ambiguity sentinel, never backfilled from ingestion
   * order.
   */
  purchasedAt: Date | null;
}

/**
 * `<provider>:<identity>` — the encoding both pair columns and
 * `overlap_older_member` store.
 *
 * Provider-qualification is load-bearing, not cosmetic: store identifiers are
 * only unique WITHIN a provider, so bare ids could map an Apple/Google pair
 * onto the same key as a different pair and silently merge two unrelated
 * overlaps (`sbr_overlap_pair_format_check` enforces the shape).
 */
export function encodeOverlapMember(
  provider: SubscriptionProvider,
  identity: string,
): string {
  return `${provider}:${identity}`;
}

/** The two halves of a stored member encoding, or null for a malformed one. */
export function decodeOverlapMember(
  encoded: string,
): { provider: SubscriptionProvider; identity: string } | null {
  const separator = encoded.indexOf(':');
  if (separator <= 0 || separator === encoded.length - 1) return null;
  const provider = encoded.slice(0, separator);
  if (provider !== 'stripe' && provider !== 'apple' && provider !== 'google') {
    return null;
  }
  return { provider, identity: encoded.slice(separator + 1) };
}

export interface OverlapPairRow {
  low: string;
  high: string;
  /**
   * The member the store says was purchased FIRST — the refund target. NULL is
   * the ambiguity sentinel: either purchase time missing, or the two EQUAL
   * (Stripe's `created` has second granularity, so ties are real). An invented
   * tie-break would hand an operator a confident wrong answer about which
   * subscription to refund.
   */
  olderMember: string | null;
}

/**
 * Canonicalise an unordered pair: low/high by byte-wise ascending comparison of
 * the ENCODED strings, and the refund-target role from the store's chronology.
 *
 * JavaScript's `<` compares UTF-16 code units, which agrees with the
 * database's `COLLATE "C"` byte order for the ASCII store identifiers these
 * encodings hold — `sbr_overlap_pair_order_check` re-asserts the ordering at
 * the database so a disagreement fails loudly rather than as duplicate rows.
 *
 * Byte-sorting preserves both identities and DESTROYS which one was already
 * there, and the role cannot be re-derived later (the Stripe side has no
 * subscription-created timestamp on `users`) — so it is computed here, at
 * creation, from `purchasedAt`.
 */
export function buildOverlapPair(
  a: OverlapMember,
  b: OverlapMember,
): OverlapPairRow {
  const encodedA = encodeOverlapMember(a.provider, a.identity);
  const encodedB = encodeOverlapMember(b.provider, b.identity);
  const [low, high] =
    encodedA < encodedB ? [encodedA, encodedB] : [encodedB, encodedA];

  let olderMember: string | null = null;
  if (a.purchasedAt != null && b.purchasedAt != null) {
    const timeA = a.purchasedAt.getTime();
    const timeB = b.purchasedAt.getTime();
    // Strict inequality on purpose: EQUAL timestamps record an ambiguous
    // target, not a tie-broken one.
    if (timeA < timeB) olderMember = encodedA;
    else if (timeB < timeA) olderMember = encodedB;
  }

  return { low, high, olderMember };
}

/**
 * When a provisional pair stops waiting and escalates: the MINIMUM of both
 * members' EFFECTIVE period ends, plus the grace margin.
 *
 * The fallback is substituted for EACH null member individually, then the
 * minimum taken — not "use the known end when only one is null": a null-period
 * source paired with an annual one would otherwise first be checked at the
 * annual boundary, long past the null member's own 35-day bound, leaving two
 * subscriptions billing unresolved for most of a year.
 *
 * By the earliest boundary either that source has renewed (a duplicate) or it
 * has ended (a replacement), so the earliest end DISCRIMINATES rather than
 * merely expiring. Non-null by construction — `sbr_provisional_deadline_check`
 * would reject the row otherwise, and a null deadline is never swept.
 */
export function computeEscalateAfter(
  members: readonly [OverlapMember, OverlapMember],
  fallbackWindowMs: number,
  graceMs: number,
): Date {
  const earliestEffectiveEnd = Math.min(
    ...members.map((member) =>
      effectivePeriodEnd(
        member.currentPeriodEnd,
        member.observedAt,
        fallbackWindowMs,
      ).getTime(),
    ),
  );
  return new Date(earliestEffectiveEnd + graceMs);
}

/**
 * Every unordered pair of the given future-billing sources.
 *
 * Overlaps are PAIRWISE: with three live sources A, B and C there are THREE
 * overlaps (A–B, A–C and B–C), each with its own row, so that when the member
 * one row happens to record terminates, the others survive with their own
 * renewal and deadline tracking.
 */
export function allOverlapPairs(
  sources: readonly OverlapMember[],
): Array<[OverlapMember, OverlapMember]> {
  const pairs: Array<[OverlapMember, OverlapMember]> = [];
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const a = sources[i];
      const b = sources[j];
      if (a && b) pairs.push([a, b]);
    }
  }
  return pairs;
}
