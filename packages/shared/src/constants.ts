import { formatCurrencyAmount } from "./format";

export const ROAD_QUALITY = {
  EXCELLENT: 5,
  GOOD: 4,
  FAIR: 3,
  POOR: 2,
  VERY_POOR: 1,
} as const;

export const SURFACE_TYPES = [
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
  "unknown",
] as const;

export type SurfaceType = (typeof SURFACE_TYPES)[number];

export const HAZARD_TYPES = [
  "pothole",
  "gravel",
  "oil_spill",
  "roadworks",
  "animals",
  "police",
  "flooding",
  "ice",
  "other",
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

export const HAZARD_SEVERITY = ["low", "medium", "high"] as const;

export type HazardSeverity = (typeof HAZARD_SEVERITY)[number];

/**
 * Default lifetime (hours) the backend applies to a hazard of each type when
 * assigning `expires_at`. Single-sourced here so the mobile offline queue can
 * expire a report that has been held (cap/offline) longer than its own hazard's
 * lifetime — submitting such a stale observation would broadcast it as a fresh
 * alert. Keep in lockstep with `HAZARD_TYPES`. Callers fall back to 24h for an
 * unknown key.
 */
export const HAZARD_EXPIRY_HOURS: Record<string, number> = {
  pothole: 72,
  gravel: 48,
  oil_spill: 24,
  roadworks: 72,
  animals: 24,
  police: 24,
  flooding: 48,
  ice: 48,
  other: 24,
};

/**
 * Machine-readable code carried on the 409 body when a hazard report tries to
 * attach a managed photo whose upload the orphan sweep already reclaimed (the
 * report sat queued past the 24h grace window). Single source of truth for the
 * wire code: the backend raises it (see `HAZARD_PHOTO_EXPIRED_CODE`) and the
 * mobile client keys on it to re-upload from its retained local URI and resubmit
 * rather than silently dropping the photo.
 */
export const HAZARD_PHOTO_EXPIRED = "HAZARD_PHOTO_EXPIRED";

export const RIDE_TYPES = ["free", "commute", "trip", "tracked"] as const;

export type RideType = (typeof RIDE_TYPES)[number];

export const WAYPOINT_TYPES = [
  "start",
  "via",
  "fuel",
  "food",
  "coffee",
  "hotel",
  "photo",
  "end",
] as const;

export type WaypointType = (typeof WAYPOINT_TYPES)[number];

/**
 * Kinds of along-route POI the API serves — the `kind` enum of the `/poi`
 * endpoints. Mirrors the OSM tag subset we accept; anything outside this list
 * is dropped at the provider layer so clients never see an unknown kind. Kept
 * deliberately small (restaurants + viewpoints + cafés + fuel stations). The
 * wider set the importer *stores* in `pois.kind` is intentionally decoupled
 * from this served enum, so widening the store never changes the API contract.
 */
export const POI_KINDS = [
  "restaurant",
  "viewpoint",
  "cafe",
  "fuel_station",
] as const;

export type PoiKind = (typeof POI_KINDS)[number];

/**
 * Curated planner POI categories shared by persistence and clients. Unlike
 * `POI_KINDS`, this includes Tarmoto-derived route highlights and overnight
 * categories used by the companion planner.
 */
export const PLANNER_POI_CATEGORIES = [
  "fuel",
  "food",
  "cafe",
  "viewpoint",
  "campground",
  "biker_hotel",
  "mountain_pass",
  "twisty_highlight",
] as const;

export type PlannerPoiCategory = (typeof PLANNER_POI_CATEGORIES)[number];

/**
 * Kinds of overnight stop the API serves — the `kind` enum of the
 * `/accommodations` endpoint. Mirrors the OSM `tourism=*` tag subset we accept;
 * anything outside this list is dropped at the provider layer.
 */
export const ACCOMMODATION_KINDS = [
  "hotel",
  "motel",
  "hostel",
  "guest_house",
  "apartment",
  "chalet",
  "camp_site",
] as const;

export type AccommodationKind = (typeof ACCOMMODATION_KINDS)[number];

// Ascending order: free → pro (mid, €29.99) → premium (top, €49.99).
// Naming decided 2026-07: "Pro" is the mid tier, "Premium" the top tier
// (the marketing page originally shipped them the other way around).
export const SUBSCRIPTION_TIERS = ["free", "pro", "premium"] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/**
 * The tiers a GRANT may confer — founder, promo or admin.
 *
 * `free` is deliberately absent, and the database enforces the same domain. A
 * grant of `free` can never win `higherTier(grant, subscription)`, so it would
 * record a complete, well-sourced grant that entitles nothing: a promo the
 * operator believes they issued and the rider never receives. Revocation is
 * clearing the grant columns, NOT granting `free`.
 */
export const GRANT_TIERS = ["pro", "premium"] as const;

export type GrantTier = (typeof GRANT_TIERS)[number];

/**
 * Paid tiers eligible for the launch-mode auto-grant on registration.
 *
 * The same set as {@link GRANT_TIERS} — a launch grant is one kind of grant.
 * Kept as its own name because it is what the admin launch-tier API validates
 * against; a spec asserts the two stay identical.
 */
export const LAUNCH_GRANT_TIERS = ["pro", "premium"] as const;

export type LaunchGrantTier = (typeof LAUNCH_GRANT_TIERS)[number];

/**
 * The tiers a STORE SUBSCRIPTION may confer — an Apple or Google product.
 *
 * The same set as {@link GRANT_TIERS} today, and kept as its own name for the
 * same reason `LAUNCH_GRANT_TIERS` is: it answers a different question, and a
 * spec asserts they stay identical.
 *
 * `free` is absent because it is not a weaker store subscription but the
 * ABSENCE of one, which `store_subscriptions` represents by having no row and
 * `users.store_subscription_tier` by NULL. Admitting it would be a second
 * encoding of that fact — and `higherTier` ranks an unrecognised value at -1,
 * the same rank as null, so a stray `free` silently unentitles a billed rider
 * rather than failing where it was written. The database enforces the same
 * domain (`ss_tier_check`, `users_store_rollup_tier_check`).
 */
export const STORE_TIERS = ["pro", "premium"] as const;

export type StoreTier = (typeof STORE_TIERS)[number];

/**
 * How a user got their tier: `subscription` = paid via Stripe,
 * `founder` = launch-mode auto-grant at registration, `promo` = a promo
 * code / campaign, `admin` = manual operator grant. Null on rows
 * predating the column (indistinguishable from `subscription`).
 */
export const PLAN_SOURCES = [
  "subscription",
  "founder",
  "promo",
  "admin",
] as const;

export type PlanSource = (typeof PLAN_SOURCES)[number];

/**
 * The plan sources that are GRANTS rather than paid subscriptions.
 *
 * Kept beside `PLAN_SOURCES` so the two cannot drift: adding a source without
 * deciding which side of this line it falls on is the mistake that made
 * "is this tier mine to touch?" a re-derived predicate in the first place.
 *
 * Null is deliberately absent, and that is load-bearing: `PLAN_SOURCES`
 * documents null as "indistinguishable from `subscription`", so a legacy row
 * must be treated as BILLED. Treating it as a grant would make every
 * pre-column paid rider un-cancellable.
 */
export const GRANT_PLAN_SOURCES = ["founder", "promo", "admin"] as const;

export type GrantPlanSource = (typeof GRANT_PLAN_SOURCES)[number];

export function isGrantPlanSource(
  source: PlanSource | null | undefined,
): source is GrantPlanSource {
  return (
    source != null && (GRANT_PLAN_SOURCES as readonly string[]).includes(source)
  );
}

/**
 * The HIGHER of two subscription tiers, by the ascending order of
 * `SUBSCRIPTION_TIERS`.
 *
 * Entitlement is the max of what a rider was GRANTED and what they are
 * SUBSCRIBED to, so neither can silently revoke the other: a grant survives a
 * failed checkout, and a paid upgrade is not capped by an older grant. Sharing
 * one column instead is what let a Stripe terminal clear destroy a founder
 * grant.
 *
 * An unrecognised value ranks below `free` rather than throwing — this sits on
 * the entitlement read path, and failing closed to the lowest tier is the safe
 * direction for an unknown.
 */
export function higherTier(
  a: SubscriptionTier | null | undefined,
  b: SubscriptionTier | null | undefined,
): SubscriptionTier {
  const rank = (tier: SubscriptionTier | null | undefined): number =>
    tier == null ? -1 : SUBSCRIPTION_TIERS.indexOf(tier);
  const best = Math.max(rank(a), rank(b));
  return best < 0 ? "free" : (SUBSCRIPTION_TIERS[best] as SubscriptionTier);
}

/**
 * Provenance of a road segment's OSM-derived quality seed (design 2026-07-15).
 * The signal the seed was derived from, in precedence order. Never includes a
 * "reading" value — rider contribution is conveyed by `reading_count`, not this.
 */
export const QUALITY_SOURCES = [
  "osm_smoothness",
  "osm_surface",
  "osm_highway",
] as const;

export type QualitySource = (typeof QUALITY_SOURCES)[number];

// Canonical EUR-denominated PRD pricing. Display code MUST go through
// `formatSubscriptionPriceLabel` / `formatSubscriptionAmountLabel`
// rather than hardcoding currency strings — keeping the field name
// (`price_eur`) and the rendered prefix (`€`) in lockstep, and giving
// us a single seam to swap if the canonical display currency ever
// changes.
export const SUBSCRIPTION_PRICING: Record<
  SubscriptionTier,
  { price_eur: number; interval: "month" | "year" }
> = {
  free: { price_eur: 0, interval: "year" },
  pro: { price_eur: 29.99, interval: "year" },
  premium: { price_eur: 49.99, interval: "year" },
};

// Plan-card price (e.g. "€29.99/yr"). Free is rendered without an
// interval suffix because "€0/yr" reads as a quirky billing claim
// rather than "this plan costs nothing".
export interface SubscriptionPriceFormatOptions {
  locale?: string;
  yearLabel?: string;
  monthLabel?: string;
}

export function formatSubscriptionPriceLabel(
  tier: SubscriptionTier,
  options: SubscriptionPriceFormatOptions = {},
): string {
  const { price_eur, interval } = SUBSCRIPTION_PRICING[tier];
  const amount = formatCurrencyAmount(
    price_eur,
    "EUR",
    options.locale ?? "en",
    {
      minimumFractionDigits: price_eur === 0 ? 0 : 2,
      maximumFractionDigits: price_eur === 0 ? 0 : 2,
    },
  );
  if (price_eur === 0) return amount;
  const suffix =
    interval === "year"
      ? (options.yearLabel ?? "yr")
      : (options.monthLabel ?? "mo");
  return `${amount}/${suffix}`;
}

// Invoice / charge amount (e.g. "€29.99") without billing-interval
// suffix — used for billing-history rows and confirmation emails.
export function formatSubscriptionAmountLabel(
  tier: SubscriptionTier,
  locale = "en",
): string {
  const { price_eur } = SUBSCRIPTION_PRICING[tier];
  return formatCurrencyAmount(price_eur, "EUR", locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const SUBSCRIPTION_PROVIDERS = ["stripe", "apple", "google"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export const SUBSCRIPTION_MANAGED_BY = [
  "stripe_portal",
  "app_store",
  "play_store",
] as const;
export type SubscriptionManagedBy = (typeof SUBSCRIPTION_MANAGED_BY)[number];

export function managedByForProvider(
  provider: SubscriptionProvider,
): SubscriptionManagedBy {
  return provider === "apple"
    ? "app_store"
    : provider === "google"
      ? "play_store"
      : "stripe_portal";
}

/** Two Apple products per tier because StoreKit auto-applies a configured
 * intro offer; the no-trial product is bought when a rider is ineligible. */
export interface IapTierProducts {
  apple: { trial: string; noTrial: string };
  google: { productId: string; trialOffer: string; noTrialBasePlan: string };
}
export const IAP_PRODUCTS: Record<
  Exclude<SubscriptionTier, "free">,
  IapTierProducts
> = {
  pro: {
    apple: {
      trial: "com.tarmoto.pro.annual.trial",
      noTrial: "com.tarmoto.pro.annual",
    },
    google: {
      productId: "pro_annual",
      trialOffer: "pro-annual-trial",
      noTrialBasePlan: "pro-annual",
    },
  },
  premium: {
    apple: {
      trial: "com.tarmoto.premium.annual.trial",
      noTrial: "com.tarmoto.premium.annual",
    },
    google: {
      productId: "premium_annual",
      trialOffer: "premium-annual-trial",
      noTrialBasePlan: "premium-annual",
    },
  },
};
