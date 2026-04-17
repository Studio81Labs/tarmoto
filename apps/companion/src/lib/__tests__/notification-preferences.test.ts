import type { NotificationPreferences } from "../types";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
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
      emailDigest: "daily",
      marketingEmails: true,
    });
    expect(merged.emailDigest).toBe("daily");
    expect(merged.marketingEmails).toBe(true);
    expect(merged.hazardAlertsSavedRoutes).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.hazardAlertsSavedRoutes,
    );
  });

  it("rejects unknown emailDigest values and keeps the default", () => {
    const merged = mergeWithDefaults({
      emailDigest:
        "hourly" as unknown as NotificationPreferences["emailDigest"],
    });
    expect(merged.emailDigest).toBe(
      DEFAULT_NOTIFICATION_PREFERENCES.emailDigest,
    );
  });

  it("preserves channel defaults when the key is absent from the payload", () => {
    // Regression: when the server returns only scalar fields, every channel
    // key must keep its default (previously they were all wiped to false).
    const merged = mergeWithDefaults({ emailDigest: "daily" });
    expect(merged.hazardAlertsSavedRoutes).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.hazardAlertsSavedRoutes,
    );
    expect(merged.tripCollaboration).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.tripCollaboration,
    );
  });

  it("overlays a partial channel onto the key's default", () => {
    // routeComments default is { email: false, push: true } — supplying only
    // email should retain the default push value.
    const merged = mergeWithDefaults({ routeComments: { email: true } });
    expect(merged.routeComments).toEqual({ email: true, push: true });
  });

  it("falls back to channel defaults for non-boolean values", () => {
    // rideLikes default is { email: false, push: true }.
    const merged = mergeWithDefaults({
      rideLikes: {
        email: "yes" as unknown as boolean,
        push: 1 as unknown as boolean,
      },
    });
    expect(merged.rideLikes).toEqual({ email: false, push: true });
  });
});

describe("preferencesEqual", () => {
  it("returns true for identical preferences", () => {
    expect(
      preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
      }),
    ).toBe(true);
  });

  it("detects digest frequency changes", () => {
    const changed = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      emailDigest: "daily" as const,
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });

  it("detects marketing toggle changes", () => {
    const changed = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      marketingEmails: true,
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });

  it("detects per-channel changes", () => {
    const changed: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      newFollowers: { email: true, push: true },
    };
    expect(preferencesEqual(DEFAULT_NOTIFICATION_PREFERENCES, changed)).toBe(
      false,
    );
  });
});
