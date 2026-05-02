# 0003 — Subscription pricing is EUR-denominated and EUR-displayed

**Status:** Accepted
**Date:** 2026-05-02

## Context

PR #320 (resolving #282) centralized subscription tier names and pricing in
`@tarmoto/shared` as `SUBSCRIPTION_PRICING`, with the field name `price_eur`.
Display code in the backend `PLAN_CATALOG` and the companion fallback
snapshot kept rendering the same numbers as `$N/yr` to preserve the
"no behaviour change" constraint of #282. The product spec section 6
also wrote prices with a `$` prefix (`$29.99/year`, `$49.99/year`).

This left the system encoding two contradictory currencies for a single
number: the storage field name says EUR, the rendered string says USD.
A reviewer flagged this on PR #320; #322 was opened to reconcile it.
Either side could be made canonical:

1. Switch to USD: rename `price_eur` → `price_usd` (or generic `price` +
   `currency`), keep the existing UI labels.
2. Switch to EUR: keep `price_eur`, rewrite UI labels to `€N/yr`,
   align the PRD.

## Decision

The canonical display currency is **EUR**. `SUBSCRIPTION_PRICING.price_eur`
keeps its name; display code goes through new helpers
`formatSubscriptionPriceLabel(tier)` and `formatSubscriptionAmountLabel(tier)`
in `@tarmoto/shared` rather than hardcoding currency strings.

Reasons for picking EUR over USD:

- The shared constant already commits to EUR (`price_eur`); flipping the
  field name back to USD would be the larger churn and would also have
  to update Stripe price-creation expectations.
- The product spec's MRR projections (section 6.1) are already
  EUR-denominated (`€1,250`, `€4,375`, …). The Tarmoto financial model
  is intrinsically euro-based; the `$` mentions in section 6 only
  appear because the spec was quoting competitor pricing, not setting
  Tarmoto's own.
- Tarmoto's primary launch markets are European; EUR is the natural
  default. Multi-currency display is out of scope for MVP-2 and can
  be added later by extending the helpers.

## Consequences

- Display labels (`PLAN_CATALOG`, `buildFallbackSubscriptionSnapshot`,
  the e2e mock backend, the OpenAPI DTO examples) are now `€N/yr` /
  `€N`. The companion subscription page and confirmation emails inherit
  these labels because they render server-provided strings.
- `SUBSCRIPTION_PRICING` has its first display consumers, so the
  "field name vs rendered prefix" inconsistency is gone — any future
  edit to a price has exactly one source of truth.
- Stripe prices are still configured per-environment via
  `TARMOTO_STRIPE_PREMIUM_PRICE_ID` / `TARMOTO_STRIPE_PRO_PRICE_ID`.
  Those Stripe prices SHOULD be set up in EUR for production so that
  `formatAmountLabel` (which trusts `invoice.currency`) renders real
  invoices in the same currency as the plan card. Validating this is an
  ops task during launch readiness, not a code-level concern.
- Adding a second currency later means either (a) extending the helpers
  to take a locale argument and exposing a `SUBSCRIPTION_PRICING_USD` /
  per-locale lookup, or (b) reshaping `SUBSCRIPTION_PRICING` to
  `{ amount, currency }` and reading `currency` in the formatter. We
  did not preemptively pick one — YAGNI until a second market is on the
  roadmap.

## Alternatives considered

- **Switch to USD.** Rejected: contradicts both the existing field name
  and the EUR-denominated revenue model already in the spec.
- **Currency-neutral shape (`{ price: number, currency: string }`).**
  Rejected for now: solves a problem we don't have. Today Tarmoto
  charges in one currency; the helpers can be evolved when a second
  one is on the roadmap.
- **Render `$` and `€` based on user locale.** Rejected for MVP-2:
  needs FX rates, locale plumbing, and Stripe multi-currency price
  configuration. Out of scope here; this ADR only fixes the
  spec-vs-code mismatch.
