import type { PrivacySettings } from "../types";
import {
  DEFAULT_PRIVACY_SETTINGS,
  mergeWithDefaults,
  settingsEqual,
} from "../privacy-settings";

describe("mergeWithDefaults", () => {
  it("returns defaults when given null or undefined", () => {
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_PRIVACY_SETTINGS);
    expect(mergeWithDefaults(undefined)).toEqual(DEFAULT_PRIVACY_SETTINGS);
  });

  it("overlays valid scalar fields", () => {
    const merged = mergeWithDefaults({
      profileVisibility: "public",
      defaultRideSharing: "public",
      locationRetention: "2years",
      roadDataContribution: false,
      analyticsConsent: false,
      personalizedRecommendationsConsent: false,
    });
    expect(merged).toEqual({
      profileVisibility: "public",
      defaultRideSharing: "public",
      locationRetention: "2years",
      roadDataContribution: false,
      analyticsConsent: false,
      personalizedRecommendationsConsent: false,
    });
  });

  it("rejects unknown enum values and keeps defaults", () => {
    const merged = mergeWithDefaults({
      profileVisibility:
        "friends" as unknown as PrivacySettings["profileVisibility"],
      defaultRideSharing:
        "unlisted" as unknown as PrivacySettings["defaultRideSharing"],
      locationRetention:
        "10years" as unknown as PrivacySettings["locationRetention"],
    });
    expect(merged.profileVisibility).toBe(
      DEFAULT_PRIVACY_SETTINGS.profileVisibility,
    );
    expect(merged.defaultRideSharing).toBe(
      DEFAULT_PRIVACY_SETTINGS.defaultRideSharing,
    );
    expect(merged.locationRetention).toBe(
      DEFAULT_PRIVACY_SETTINGS.locationRetention,
    );
  });

  it("rejects non-boolean consent flags and keeps defaults", () => {
    const merged = mergeWithDefaults({
      roadDataContribution:
        "yes" as unknown as PrivacySettings["roadDataContribution"],
      analyticsConsent: 1 as unknown as PrivacySettings["analyticsConsent"],
      personalizedRecommendationsConsent:
        null as unknown as PrivacySettings["personalizedRecommendationsConsent"],
    });
    expect(merged.roadDataContribution).toBe(
      DEFAULT_PRIVACY_SETTINGS.roadDataContribution,
    );
    expect(merged.analyticsConsent).toBe(
      DEFAULT_PRIVACY_SETTINGS.analyticsConsent,
    );
    expect(merged.personalizedRecommendationsConsent).toBe(
      DEFAULT_PRIVACY_SETTINGS.personalizedRecommendationsConsent,
    );
  });

  it("preserves untouched fields when only some are provided", () => {
    const merged = mergeWithDefaults({ profileVisibility: "private" });
    expect(merged.profileVisibility).toBe("private");
    expect(merged.defaultRideSharing).toBe(
      DEFAULT_PRIVACY_SETTINGS.defaultRideSharing,
    );
    expect(merged.locationRetention).toBe(
      DEFAULT_PRIVACY_SETTINGS.locationRetention,
    );
    expect(merged.roadDataContribution).toBe(
      DEFAULT_PRIVACY_SETTINGS.roadDataContribution,
    );
  });
});

describe("settingsEqual", () => {
  it("returns true for identical settings", () => {
    expect(
      settingsEqual(DEFAULT_PRIVACY_SETTINGS, {
        ...DEFAULT_PRIVACY_SETTINGS,
      }),
    ).toBe(true);
  });

  it("detects profile visibility changes", () => {
    const changed: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      profileVisibility: "public",
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, changed)).toBe(false);
  });

  it("detects ride sharing changes", () => {
    const changed: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      defaultRideSharing: "public",
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, changed)).toBe(false);
  });

  it("detects location retention changes", () => {
    const changed: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      locationRetention: "forever",
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, changed)).toBe(false);
  });

  it("detects toggle changes", () => {
    const changed: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      roadDataContribution: !DEFAULT_PRIVACY_SETTINGS.roadDataContribution,
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, changed)).toBe(false);
  });

  it("detects consent changes", () => {
    const analyticsChanged: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      analyticsConsent: !DEFAULT_PRIVACY_SETTINGS.analyticsConsent,
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, analyticsChanged)).toBe(
      false,
    );
    const persChanged: PrivacySettings = {
      ...DEFAULT_PRIVACY_SETTINGS,
      personalizedRecommendationsConsent:
        !DEFAULT_PRIVACY_SETTINGS.personalizedRecommendationsConsent,
    };
    expect(settingsEqual(DEFAULT_PRIVACY_SETTINGS, persChanged)).toBe(false);
  });
});
