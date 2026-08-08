/**
 * The once-per-rider trial marker, `users.billing_trial_used_at` (#1132).
 *
 * ## Why this module exists
 *
 * Trial consumption is a CROSS-PROVIDER, MONOTONIC, ONCE-PER-RIDER fact
 * maintained by whichever per-subscription webhook handler happens to run. It
 * was expressed inline at six write sites and three guard sites across
 * `AccountService` and `ProviderClaimService` — the same SQL retyped each time.
 *
 * Six identical spellings of one rule is not a style problem. Nothing makes them
 * agree: a seventh writer that reaches for `NOW()` instead of
 * `COALESCE(..., NOW())` re-dates a marker that must never move, and no test of
 * the other six would notice. The fact needs an owner.
 *
 * ## What is NOT solved here
 *
 * This centralises the VOCABULARY, not the control flow. The stamp is still
 * applied by each writer, so a path that returns before reaching its writer
 * still skips it — which is exactly how the last of #1131's eleven review
 * rounds was found (an early `return` sitting above the stamps). Making the
 * stamp unskippable means moving it to the point entitlement is DECIDED, which
 * is a restructure of `applyStripeSubscriptionEvent`. Tracked on #1132.
 */

/** The column, named once so a rename cannot half-land. */
export const TRIAL_MARKER_COLUMN = 'billing_trial_used_at';

/**
 * The MONOTONIC stamp: set the marker if unset, never re-date it.
 *
 * `COALESCE`, not `NOW()`. The marker records when the rider's single trial was
 * consumed, and every writer may fire more than once — redeliveries, later
 * `updated` events of a subscription that once had a trial, the fallback stamp.
 * Re-dating would walk the date forward on every one of them, so any eligibility
 * window keyed off it never closes and the record of when the trial was actually
 * used is destroyed.
 *
 * Returned as a TypeORM raw-value factory, which is the shape every `.set()`
 * call site needs.
 */
export const trialMarkerStamp = (): (() => string) => () =>
  `COALESCE(${TRIAL_MARKER_COLUMN}, NOW())`;

/**
 * The ELIGIBILITY predicate: this rider has not consumed their trial.
 *
 * Deliberately paired with the stamp in one module, because they are two halves
 * of one rule and drifted apart before: the guard decides whether a trial may be
 * GRANTED, the stamp records that it WAS. A guard that says one thing while the
 * stamp says another grants a second trial or refuses a first.
 *
 * Bare predicate, for `andWhere`. Callers that need it inside a larger SQL
 * fragment prefix their own ` AND `.
 */
export const TRIAL_ELIGIBLE_PREDICATE = `${TRIAL_MARKER_COLUMN} IS NULL`;
