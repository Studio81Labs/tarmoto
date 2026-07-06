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

// Ascending order: free → pro (mid, €29.99) → premium (top, €49.99).
// Naming decided 2026-07: "Pro" is the mid tier, "Premium" the top tier
// (the marketing page originally shipped them the other way around).
export const SUBSCRIPTION_TIERS = ["free", "pro", "premium"] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/** Paid tiers eligible for the launch-mode auto-grant on registration. */
export const LAUNCH_GRANT_TIERS = ["pro", "premium"] as const;

export type LaunchGrantTier = (typeof LAUNCH_GRANT_TIERS)[number];

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
export function formatSubscriptionPriceLabel(tier: SubscriptionTier): string {
  const { price_eur, interval } = SUBSCRIPTION_PRICING[tier];
  if (price_eur === 0) return "€0";
  const suffix = interval === "year" ? "/yr" : "/mo";
  return `€${price_eur.toFixed(2)}${suffix}`;
}

// Invoice / charge amount (e.g. "€29.99") without billing-interval
// suffix — used for billing-history rows and confirmation emails.
export function formatSubscriptionAmountLabel(tier: SubscriptionTier): string {
  const { price_eur } = SUBSCRIPTION_PRICING[tier];
  return `€${price_eur.toFixed(2)}`;
}
