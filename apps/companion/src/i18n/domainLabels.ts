import type { EnglishMessageKey, Translate } from ".";
import type { SuggestionStatus } from "@/lib/api/trip-collab";
import type { Waypoint } from "@/lib/types";

export const TRIP_STATUS_LABELS = {
  draft: "Draft",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
} as const satisfies Record<string, EnglishMessageKey>;

export const TRIP_STATUS_FILTER_LABELS = {
  draft: "Drafts",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
} as const satisfies Record<string, EnglishMessageKey>;

export const TRIP_SORT_LABELS = {
  updated: "Last updated",
  created: "Date created",
  name: "Name (A to Z)",
  distance: "Distance",
} as const satisfies Record<string, EnglishMessageKey>;

export const BADGE_TIER_LABELS = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
} as const satisfies Record<string, EnglishMessageKey>;

export const PROGRESSION_TIER_LABELS = {
  "Rookie Rider": "Rookie Rider",
  "Road Tripper": "Road Tripper",
  "Curve Hunter": "Curve Hunter",
  "Mountain Goat": "Mountain Goat",
  "Pass Master": "Pass Master",
  "Tarmac Legend": "Tarmac Legend",
} as const satisfies Record<string, EnglishMessageKey>;

export const TRIP_ROLE_LABELS = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
} as const satisfies Record<string, EnglishMessageKey>;

export const SUGGESTION_STATUS_LABELS = {
  open: "Open",
  accepted: "Accepted",
  rejected: "Rejected",
} as const satisfies Record<SuggestionStatus, EnglishMessageKey>;

export const HAZARD_SEVERITY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
} as const satisfies Record<string, EnglishMessageKey>;

export const HAZARD_RISK_LABELS = {
  none: "No hazards",
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
} as const satisfies Record<string, EnglishMessageKey>;

export const PASS_STATUS_LABELS = {
  open: "Open",
  closed: "Closed",
  unknown: "Unknown",
} as const satisfies Record<string, EnglishMessageKey>;

export const CLOSURE_SEVERITY_LABELS = {
  full: "Full closure",
  partial: "Partial closure",
  advisory: "Advisory",
} as const satisfies Record<string, EnglishMessageKey>;

export const CLOSURE_SEVERITY_SHORT_LABELS = {
  full: "Full",
  partial: "Partial",
  advisory: "Advisory",
} as const satisfies Record<string, EnglishMessageKey>;

export const CLOSURE_REASON_LABELS = {
  closure: "Closure",
  roadworks: "Roadworks",
  seasonal: "Seasonal",
  weather: "Weather",
  event: "Event",
  other: "Other",
} as const satisfies Record<string, EnglishMessageKey>;

export const SEASON_LABELS = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  winter: "Winter",
} as const satisfies Record<string, EnglishMessageKey>;

export const SUBSCRIPTION_STATUS_LABELS = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Payment issue",
  canceled: "Canceled",
} as const satisfies Record<string, EnglishMessageKey>;

export const WAYPOINT_ROLE_LABELS = {
  start: "Start",
  via: "Via",
  end: "Finish",
  finish: "Finish",
  fuel: "Fuel",
  rest: "Rest",
  photo: "Photo",
  accommodation: "Stay",
} as const satisfies Record<Waypoint["type"] | "finish", EnglishMessageKey>;

/** Translate a constrained wire value, hiding unknown future codes as such. */
export function translateKnownLabel(
  value: string,
  labels: Readonly<Record<string, EnglishMessageKey>>,
  t: Translate,
): string {
  const key = labels[value];
  return t(key ?? "Unknown");
}
