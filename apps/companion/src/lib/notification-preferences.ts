import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type EmailDigestFrequency,
  type NotificationCategory,
  type NotificationChannelToggles,
  type NotificationPreferences,
} from "@tarmoto/shared";
import type { EnglishMessageKey } from "@/i18n";

// Re-exports kept so existing imports in this app keep working.
export {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type EmailDigestFrequency,
  type NotificationCategory,
  type NotificationChannelToggles,
  type NotificationPreferences,
};

export const EMAIL_DIGEST_OPTIONS: {
  value: EmailDigestFrequency;
  label: EnglishMessageKey;
  description: EnglishMessageKey;
}[] = [
  { value: "daily", label: "Daily", description: "Every morning" },
  { value: "weekly", label: "Weekly", description: "Every Sunday" },
  { value: "never", label: "Never", description: "No digest emails" },
];

// Categories the companion exposes as user-toggleable rows. The backend
// stores additional categories (`crash_followup`, `weather_alert`,
// `subscription_billing`) that fire on system-level events and are not
// settable from the settings page — they default to all-channels-on
// and aren't displayed here.
export const VISIBLE_NOTIFICATION_CATEGORIES = [
  "hazard_alert",
  "trip_collaboration",
  "new_follower",
  "route_comment",
  "ride_like",
] as const satisfies readonly NotificationCategory[];

export type VisibleNotificationCategory =
  (typeof VISIBLE_NOTIFICATION_CATEGORIES)[number];

export const VISIBLE_CATEGORY_LABELS: Record<
  VisibleNotificationCategory,
  { label: EnglishMessageKey; description: EnglishMessageKey }
> = {
  hazard_alert: {
    label: "Hazard alerts for saved routes",
    description:
      "Get warned about new potholes, roadworks, or hazards reported on routes you ride.",
  },
  trip_collaboration: {
    label: "Trip collaboration",
    description: "Invites, edits, and comments on trips you collaborate on.",
  },
  new_follower: {
    label: "New followers",
    description: "When another rider follows your profile.",
  },
  route_comment: {
    label: "Route comments",
    description: "Comments on your shared routes and rides.",
  },
  ride_like: {
    label: "Ride likes",
    description: "When riders like one of your shared rides.",
  },
};

// Server is allowed to return a partial payload (older clients, missing
// rows). The PUT endpoint also accepts a partial; the merge below
// guarantees a fully-populated `NotificationPreferences` for rendering.
export type PartialNotificationPreferences = {
  email_digest?: EmailDigestFrequency;
  marketing_emails?: boolean;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  quiet_hours_timezone?: string;
  categories?: Partial<
    Record<NotificationCategory, Partial<NotificationChannelToggles>>
  >;
};

export function mergeWithDefaults(
  partial: PartialNotificationPreferences | null | undefined,
): NotificationPreferences {
  const defaults = cloneDefaults();
  if (!partial) return defaults;

  if (isEmailDigest(partial.email_digest)) {
    defaults.email_digest = partial.email_digest;
  }
  if (typeof partial.marketing_emails === "boolean") {
    defaults.marketing_emails = partial.marketing_emails;
  }
  if (
    typeof partial.quiet_hours_start === "number" &&
    Number.isFinite(partial.quiet_hours_start)
  ) {
    defaults.quiet_hours_start = clampMinutes(partial.quiet_hours_start);
  }
  if (
    typeof partial.quiet_hours_end === "number" &&
    Number.isFinite(partial.quiet_hours_end)
  ) {
    defaults.quiet_hours_end = clampMinutes(partial.quiet_hours_end);
  }
  if (typeof partial.quiet_hours_timezone === "string") {
    defaults.quiet_hours_timezone = partial.quiet_hours_timezone || "UTC";
  }
  if (partial.categories) {
    for (const cat of NOTIFICATION_CATEGORIES) {
      const override = partial.categories[cat];
      if (!override) continue;
      defaults.categories[cat] = mergeChannels(
        override,
        defaults.categories[cat],
      );
    }
  }
  return defaults;
}

function mergeChannels(
  partial: Partial<NotificationChannelToggles>,
  base: NotificationChannelToggles,
): NotificationChannelToggles {
  return {
    email: typeof partial.email === "boolean" ? partial.email : base.email,
    push: typeof partial.push === "boolean" ? partial.push : base.push,
    in_app: typeof partial.in_app === "boolean" ? partial.in_app : base.in_app,
  };
}

function isEmailDigest(value: unknown): value is EmailDigestFrequency {
  return value === "daily" || value === "weekly" || value === "never";
}

function clampMinutes(value: number): number {
  if (value < 0) return 0;
  if (value > 1439) return 1439;
  return Math.floor(value);
}

function cloneDefaults(): NotificationPreferences {
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    categories: Object.fromEntries(
      Object.entries(DEFAULT_NOTIFICATION_PREFERENCES.categories).map(
        ([k, v]) => [k, { ...v }],
      ),
    ) as NotificationPreferences["categories"],
  };
}

export function preferencesEqual(
  a: NotificationPreferences,
  b: NotificationPreferences,
): boolean {
  if (a.email_digest !== b.email_digest) return false;
  if (a.marketing_emails !== b.marketing_emails) return false;
  if (a.quiet_hours_start !== b.quiet_hours_start) return false;
  if (a.quiet_hours_end !== b.quiet_hours_end) return false;
  if (a.quiet_hours_timezone !== b.quiet_hours_timezone) return false;
  for (const cat of NOTIFICATION_CATEGORIES) {
    const left = a.categories[cat];
    const right = b.categories[cat];
    if (left.email !== right.email) return false;
    if (left.push !== right.push) return false;
    if (left.in_app !== right.in_app) return false;
  }
  return true;
}
