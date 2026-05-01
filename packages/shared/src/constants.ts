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

export const SUBSCRIPTION_TIERS = ["free", "premium", "pro"] as const;

export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_PRICING: Record<
  SubscriptionTier,
  { price_eur: number; interval: "month" | "year" }
> = {
  free: { price_eur: 0, interval: "year" },
  premium: { price_eur: 29.99, interval: "year" },
  pro: { price_eur: 49.99, interval: "year" },
};

// Renders the price label shown in plan cards across backend and companion.
// Free skips the interval suffix because there is no recurring charge — the
// `interval: 'year'` field is retained for shape consistency with paid tiers.
export function formatSubscriptionPriceLabel(tier: SubscriptionTier): string {
  const { price_eur, interval } = SUBSCRIPTION_PRICING[tier];
  if (price_eur === 0) return "$0";
  const suffix = interval === "year" ? "/yr" : "/mo";
  return `$${price_eur}${suffix}`;
}
