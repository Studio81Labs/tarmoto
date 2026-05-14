/**
 * Push notification taxonomy shared by backend, companion, and mobile.
 *
 * Categories map 1:1 to a preference toggle and to a dispatch site in
 * the backend. Adding a new category means: extend `NOTIFICATION_CATEGORIES`,
 * add a default to `DEFAULT_NOTIFICATION_PREFERENCES`, and either fold it
 * into an existing preference channel or add a new one.
 *
 * Channels (`email`/`push`/`in_app`) are independent — a category may
 * fire on one without the others. Backend gates each channel separately
 * before dispatch.
 */

export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const NOTIFICATION_CATEGORIES = [
  "hazard_alert",
  "crash_followup",
  "trip_collaboration",
  "new_follower",
  "ride_like",
  "route_comment",
  "weather_alert",
  "subscription_billing",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ["email", "push", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationChannelToggles {
  email: boolean;
  push: boolean;
  in_app: boolean;
}

export type EmailDigestFrequency = "daily" | "weekly" | "never";

/**
 * Per-user notification preference shape persisted in the backend.
 *
 * `quiet_hours_start` and `quiet_hours_end` are minutes-from-midnight
 * (0–1439) in the user's local timezone. When `start === end`, quiet
 * hours are disabled. The window may wrap midnight (e.g. 1320 → 360
 * means 22:00 → 06:00). Critical categories — currently only
 * `crash_followup` — bypass quiet hours; everything else is suppressed.
 */
export interface NotificationPreferences {
  email_digest: EmailDigestFrequency;
  marketing_emails: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  /** IANA timezone (e.g. "Europe/Prague"). Falls back to UTC if empty. */
  quiet_hours_timezone: string;
  categories: Record<NotificationCategory, NotificationChannelToggles>;
}

const allOn: NotificationChannelToggles = {
  email: true,
  push: true,
  in_app: true,
};

const pushOnlyDefault: NotificationChannelToggles = {
  email: false,
  push: true,
  in_app: true,
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  email_digest: "weekly",
  marketing_emails: false,
  quiet_hours_start: 0,
  quiet_hours_end: 0,
  quiet_hours_timezone: "UTC",
  categories: {
    hazard_alert: { ...pushOnlyDefault },
    crash_followup: { ...allOn },
    trip_collaboration: { ...allOn },
    new_follower: { ...allOn },
    ride_like: { ...pushOnlyDefault },
    route_comment: { ...pushOnlyDefault },
    weather_alert: { ...pushOnlyDefault },
    subscription_billing: { ...allOn },
  },
};

/**
 * Categories that bypass quiet hours. A rider in the middle of a crash
 * follow-up shouldn't have the dispatch suppressed because it's 23:00.
 */
export const CRITICAL_NOTIFICATION_CATEGORIES: ReadonlySet<NotificationCategory> =
  new Set(["crash_followup"]);

export interface InAppNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data: Record<string, string>;
  read_at: string | null;
  created_at: string;
}

export interface InAppNotificationListResponse {
  items: InAppNotification[];
  unread_count: number;
}
