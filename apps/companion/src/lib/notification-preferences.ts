import type {
  NotificationChannels,
  NotificationPreferences,
  EmailDigestFrequency,
} from "@/lib/types";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  emailDigest: "weekly",
  hazardAlertsSavedRoutes: { email: true, push: true },
  newFollowers: { email: false, push: true },
  routeComments: { email: false, push: true },
  rideLikes: { email: false, push: true },
  tripCollaboration: { email: true, push: true },
  marketingEmails: false,
};

export const EMAIL_DIGEST_OPTIONS: {
  value: EmailDigestFrequency;
  label: string;
  description: string;
}[] = [
  { value: "daily", label: "Daily", description: "Every morning" },
  { value: "weekly", label: "Weekly", description: "Every Monday" },
  { value: "never", label: "Never", description: "No digest emails" },
];

export type PerChannelKey =
  | "hazardAlertsSavedRoutes"
  | "newFollowers"
  | "routeComments"
  | "rideLikes"
  | "tripCollaboration";

// Allow server payloads where channel objects themselves are only partially populated.
export type PartialNotificationPreferences = {
  emailDigest?: EmailDigestFrequency;
  marketingEmails?: boolean;
} & Partial<Record<PerChannelKey, Partial<NotificationChannels>>>;

// Merge whatever the server returns with defaults so missing keys don't crash the UI.
// Narrowed to known keys; unexpected server fields are ignored.
export function mergeWithDefaults(
  partial: PartialNotificationPreferences | null | undefined,
): NotificationPreferences {
  if (!partial) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  const merged: NotificationPreferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  };
  if (isEmailDigest(partial.emailDigest))
    merged.emailDigest = partial.emailDigest;
  if (typeof partial.marketingEmails === "boolean")
    merged.marketingEmails = partial.marketingEmails;
  for (const key of [
    "hazardAlertsSavedRoutes",
    "newFollowers",
    "routeComments",
    "rideLikes",
    "tripCollaboration",
  ] as const) {
    if (partial[key] !== undefined) {
      merged[key] = mergeChannels(partial[key], merged[key]);
    }
  }
  return merged;
}

// Overlay a partial channel payload onto the provided defaults so a server
// returning only { email: true } for a key preserves the default push value.
function mergeChannels(
  partial: Partial<NotificationChannels>,
  defaults: NotificationChannels,
): NotificationChannels {
  return {
    email: typeof partial.email === "boolean" ? partial.email : defaults.email,
    push: typeof partial.push === "boolean" ? partial.push : defaults.push,
  };
}

function isEmailDigest(value: unknown): value is EmailDigestFrequency {
  return value === "daily" || value === "weekly" || value === "never";
}

export function preferencesEqual(
  a: NotificationPreferences,
  b: NotificationPreferences,
): boolean {
  if (a.emailDigest !== b.emailDigest) return false;
  if (a.marketingEmails !== b.marketingEmails) return false;
  for (const key of [
    "hazardAlertsSavedRoutes",
    "newFollowers",
    "routeComments",
    "rideLikes",
    "tripCollaboration",
  ] as const) {
    if (a[key].email !== b[key].email) return false;
    if (a[key].push !== b[key].push) return false;
  }
  return true;
}
