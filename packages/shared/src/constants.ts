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
