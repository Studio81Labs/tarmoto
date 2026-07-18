import type {
  LocationRetention,
  PrivacySettings,
  ProfileVisibility,
  RideSharingDefault,
} from "@/lib/types";
import type { EnglishMessageKey } from "@/i18n";

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  profileVisibility: "riders-only",
  defaultRideSharing: "private",
  roadDataContribution: true,
  locationRetention: "1year",
  analyticsConsent: true,
  personalizedRecommendationsConsent: true,
};

export const PROFILE_VISIBILITY_OPTIONS: {
  value: ProfileVisibility;
  label: EnglishMessageKey;
  description: EnglishMessageKey;
}[] = [
  {
    value: "public",
    label: "Public",
    description: "Anyone on the web can view your profile.",
  },
  {
    value: "riders-only",
    label: "Riders only",
    description: "Only signed-in Tarmoto riders can view your profile.",
  },
  {
    value: "private",
    label: "Private",
    description: "Your profile is hidden — only you can see it.",
  },
];

export const RIDE_SHARING_OPTIONS: {
  value: RideSharingDefault;
  label: EnglishMessageKey;
  description: EnglishMessageKey;
}[] = [
  {
    value: "public",
    label: "Public",
    description: "New rides are visible to the community by default.",
  },
  {
    value: "private",
    label: "Private",
    description: "New rides are kept to yourself by default.",
  },
];

export const LOCATION_RETENTION_OPTIONS: {
  value: LocationRetention;
  label: EnglishMessageKey;
  // Two entries below have no description ("") — not every registered catalog
  // key, so this stays `string` and the render site uses `tDynamic`.
  description: string;
}[] = [
  { value: "3months", label: "3 months", description: "Minimum retention." },
  { value: "6months", label: "6 months", description: "" },
  { value: "1year", label: "1 year", description: "Recommended." },
  { value: "2years", label: "2 years", description: "" },
  {
    value: "forever",
    label: "Forever",
    description: "Keep my raw location data indefinitely.",
  },
];

export type PartialPrivacySettings = Partial<PrivacySettings>;

export function mergeWithDefaults(
  partial: PartialPrivacySettings | null | undefined,
): PrivacySettings {
  if (!partial) return { ...DEFAULT_PRIVACY_SETTINGS };
  const merged: PrivacySettings = { ...DEFAULT_PRIVACY_SETTINGS };
  if (isProfileVisibility(partial.profileVisibility))
    merged.profileVisibility = partial.profileVisibility;
  if (isRideSharing(partial.defaultRideSharing))
    merged.defaultRideSharing = partial.defaultRideSharing;
  if (isLocationRetention(partial.locationRetention))
    merged.locationRetention = partial.locationRetention;
  if (typeof partial.roadDataContribution === "boolean")
    merged.roadDataContribution = partial.roadDataContribution;
  if (typeof partial.analyticsConsent === "boolean")
    merged.analyticsConsent = partial.analyticsConsent;
  if (typeof partial.personalizedRecommendationsConsent === "boolean")
    merged.personalizedRecommendationsConsent =
      partial.personalizedRecommendationsConsent;
  return merged;
}

function isProfileVisibility(value: unknown): value is ProfileVisibility {
  return value === "public" || value === "riders-only" || value === "private";
}

function isRideSharing(value: unknown): value is RideSharingDefault {
  return value === "public" || value === "private";
}

function isLocationRetention(value: unknown): value is LocationRetention {
  return (
    value === "3months" ||
    value === "6months" ||
    value === "1year" ||
    value === "2years" ||
    value === "forever"
  );
}

export function settingsEqual(a: PrivacySettings, b: PrivacySettings): boolean {
  return (
    a.profileVisibility === b.profileVisibility &&
    a.defaultRideSharing === b.defaultRideSharing &&
    a.roadDataContribution === b.roadDataContribution &&
    a.locationRetention === b.locationRetention &&
    a.analyticsConsent === b.analyticsConsent &&
    a.personalizedRecommendationsConsent ===
      b.personalizedRecommendationsConsent
  );
}
