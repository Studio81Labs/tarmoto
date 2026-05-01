import type {
  EmailDigestFrequency,
  NotificationPreferences,
} from "@tarmoto/shared";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  VISIBLE_NOTIFICATION_CATEGORIES,
  mergeWithDefaults,
  preferencesEqual,
} from "../notification-preferences";

describe("mergeWithDefaults", () => {
  it("returns defaults when given null or undefined", () => {
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(mergeWithDefaults(undefined)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it("overlays partial top-level fields", () => {
    const merged = mergeWithDefaults({
      email_digest: "daily",
      marketing_emails: true,
    });
    expect(merged.email_digest).toBe("daily");
    expect(merged.marketing_emails).toBe(true);
    expect(merged.categories.hazard_alert).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.categories.hazard_alert,
    );
  });

  it("rejects unknown email_digest values and keeps the default", () => {
    const merged = mergeWithDefaults({
      email_digest: "hourly" as unknown as EmailDigestFrequency,
    });
    expect(merged.email_digest).toBe(
      DEFAULT_NOTIFICATION_PREFERENCES.email_digest,
    );
  });

  it("preserves category defaults when the categories key is absent", () => {
    const merged = mergeWithDefaults({ email_digest: "daily" });
    for (const category of VISIBLE_NOTIFICATION_CATEGORIES) {
      expect(merged.categories[category]).toEqual(
        DEFAULT_NOTIFICATION_PREFERENCES.categories[category],
      );
    }
  });

  it("overlays a partial channel onto the category's default", () => {
    const merged = mergeWithDefaults({
      categories: { route_comment: { email: true } },
    });
    expect(merged.categories.route_comment).toEqual({
      email: true,
      push: true,
      in_app: true,
    });
  });

  it("falls back to channel defaults for non-boolean values", () => {
    const merged = mergeWithDefaults({
      categories: {
        ride_like: {
          email: "yes" as unknown as boolean,
          push: 1 as unknown as boolean,
        },
      },
    });
    expect(merged.categories.ride_like).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.categories.ride_like,
    );
  });

  it("clamps quiet_hours_* into the 0..1439 minute range", () => {
    const merged = mergeWithDefaults({
      quiet_hours_start: -5,
      quiet_hours_end: 99999,
    });
    expect(merged.quiet_hours_start).toBe(0);
    expect(merged.quiet_hours_end).toBe(1439);
  });
});

describe("preferencesEqual", () => {
  it("returns true for identical preferences", () => {
    expect(
      preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        categories: { ...DEFAULT_NOTIFICATION_PREFERENCES.categories },
      }),
    ).toBe(true);
  });

  it("detects digest frequency changes", () => {
    const changed: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      email_digest: "daily",
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });

  it("detects marketing toggle changes", () => {
    const changed: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      marketing_emails: true,
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });

  it("detects per-category channel changes", () => {
    const changed: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      categories: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.categories,
        new_follower: { email: false, push: false, in_app: false },
      },
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });
});
