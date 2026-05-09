import {
  DEFAULT_PRIVACY_PREFERENCES,
  canShowPersonalizedRecommendations,
  canTrackAnalytics,
  shouldContributeRoadData,
  type PrivacyPreferences,
} from '@tarmoto/shared';

/**
 * Cross-app privacy helpers (#279 / #501) — these wrap the boolean
 * toggles into single-purpose predicates so every call site
 * (companion analytics, mobile sensor uploader, recommendation
 * services) gates on the exact same boolean. The fail-closed posture
 * (default to "no" on anything unexpected) is the load-bearing
 * property: silently re-enabling a toggled-off feature would defeat
 * the rider's explicit opt-out.
 *
 * The shared package has no test runner of its own — the helpers
 * are pure functions, so we exercise them from the backend's jest
 * suite (which depends on `@tarmoto/shared`) rather than introduce
 * a parallel runner.
 */
describe('shared privacy helpers (#279 / #501)', () => {
  describe('canTrackAnalytics', () => {
    it('returns true when consent is the canonical default (true)', () => {
      expect(canTrackAnalytics(DEFAULT_PRIVACY_PREFERENCES)).toBe(true);
    });

    it('returns false when consent is explicitly off', () => {
      const prefs: PrivacyPreferences = {
        ...DEFAULT_PRIVACY_PREFERENCES,
        analytics_consent: false,
      };
      expect(canTrackAnalytics(prefs)).toBe(false);
    });

    it('returns false for any non-true value (fail-closed)', () => {
      // Cast through unknown so we can model a coerced/garbled row
      // making it past the storage layer — the helper must not
      // re-enable tracking for an opt-out rider whose value was
      // "false" (string), 0, null, or undefined.
      const garbledValues: unknown[] = ['true', 'false', 0, 1, null, undefined];
      for (const garbled of garbledValues) {
        const prefs = {
          ...DEFAULT_PRIVACY_PREFERENCES,
          analytics_consent: garbled,
        } as unknown as PrivacyPreferences;
        expect(canTrackAnalytics(prefs)).toBe(false);
      }
    });
  });

  describe('canShowPersonalizedRecommendations', () => {
    it('returns true when consent is on', () => {
      expect(
        canShowPersonalizedRecommendations(DEFAULT_PRIVACY_PREFERENCES),
      ).toBe(true);
    });

    it('returns false when consent is off', () => {
      const prefs: PrivacyPreferences = {
        ...DEFAULT_PRIVACY_PREFERENCES,
        personalized_recommendations_consent: false,
      };
      expect(canShowPersonalizedRecommendations(prefs)).toBe(false);
    });
  });

  describe('shouldContributeRoadData', () => {
    it('returns true on the canonical default (opt-in)', () => {
      expect(shouldContributeRoadData(DEFAULT_PRIVACY_PREFERENCES)).toBe(true);
    });

    it('returns false when the rider opted out', () => {
      const prefs: PrivacyPreferences = {
        ...DEFAULT_PRIVACY_PREFERENCES,
        road_data_contribution: false,
      };
      expect(shouldContributeRoadData(prefs)).toBe(false);
    });
  });
});
