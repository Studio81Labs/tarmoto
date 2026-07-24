/**
 * Preferences store — US-5 minimum road quality filter.
 *
 * Focus: clamping (values outside 1..5 are snapped), rounding (fractional
 * input lands on an integer bucket), and that the setter survives a
 * reset. Persistence itself is delegated to MMKV and isn't asserted here
 * because the native module isn't available in jest.
 */

import { usePreferencesStore, PREFERENCES_DEFAULTS } from "../index";

describe("usePreferencesStore", () => {
  beforeEach(() => {
    useStoreReset();
  });

  it("starts at the default minimum quality", () => {
    expect(usePreferencesStore.getState().minQuality).toBe(
      PREFERENCES_DEFAULTS.minQuality,
    );
  });

  it("setMinQuality clamps below the range", () => {
    usePreferencesStore.getState().setMinQuality(-2);
    expect(usePreferencesStore.getState().minQuality).toBe(1);
  });

  it("setMinQuality clamps above the range", () => {
    usePreferencesStore.getState().setMinQuality(42);
    expect(usePreferencesStore.getState().minQuality).toBe(5);
  });

  it("setMinQuality rounds fractional input to the nearest step", () => {
    usePreferencesStore.getState().setMinQuality(3.4);
    expect(usePreferencesStore.getState().minQuality).toBe(3);

    usePreferencesStore.getState().setMinQuality(3.6);
    expect(usePreferencesStore.getState().minQuality).toBe(4);
  });

  it("setMinQuality falls back to default on NaN", () => {
    usePreferencesStore.getState().setMinQuality(Number.NaN);
    expect(usePreferencesStore.getState().minQuality).toBe(
      PREFERENCES_DEFAULTS.minQuality,
    );
  });

  it("resetPreferences returns to the default threshold", () => {
    usePreferencesStore.getState().setMinQuality(5);
    usePreferencesStore.getState().resetPreferences();
    expect(usePreferencesStore.getState().minQuality).toBe(
      PREFERENCES_DEFAULTS.minQuality,
    );
  });

  describe("weatherAlertsEnabled (US-13)", () => {
    it("starts on by default — riders opt out, not in", () => {
      expect(usePreferencesStore.getState().weatherAlertsEnabled).toBe(true);
      expect(PREFERENCES_DEFAULTS.weatherAlertsEnabled).toBe(true);
    });

    it("setWeatherAlertsEnabled flips the toggle", () => {
      usePreferencesStore.getState().setWeatherAlertsEnabled(false);
      expect(usePreferencesStore.getState().weatherAlertsEnabled).toBe(false);
      usePreferencesStore.getState().setWeatherAlertsEnabled(true);
      expect(usePreferencesStore.getState().weatherAlertsEnabled).toBe(true);
    });

    it("resetPreferences restores the on default", () => {
      usePreferencesStore.getState().setWeatherAlertsEnabled(false);
      usePreferencesStore.getState().resetPreferences();
      expect(usePreferencesStore.getState().weatherAlertsEnabled).toBe(true);
    });
  });

  describe("fuelRangeKm (US-10)", () => {
    it("starts at the default fuel range", () => {
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(
        PREFERENCES_DEFAULTS.fuelRangeKm,
      );
    });

    it("clamps values below 50 km", () => {
      usePreferencesStore.getState().setFuelRangeKm(10);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(50);
    });

    it("clamps values above 1000 km", () => {
      usePreferencesStore.getState().setFuelRangeKm(2500);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(1000);
    });

    it("snaps non-grid inputs to the nearest 50 km step", () => {
      usePreferencesStore.getState().setFuelRangeKm(237);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(250);

      usePreferencesStore.getState().setFuelRangeKm(262);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(250);

      usePreferencesStore.getState().setFuelRangeKm(275);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(300);
    });

    it("falls back to the default on NaN", () => {
      usePreferencesStore.getState().setFuelRangeKm(Number.NaN);
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(
        PREFERENCES_DEFAULTS.fuelRangeKm,
      );
    });

    it("resetPreferences restores the fuel-range default", () => {
      usePreferencesStore.getState().setFuelRangeKm(500);
      usePreferencesStore.getState().resetPreferences();
      expect(usePreferencesStore.getState().fuelRangeKm).toBe(
        PREFERENCES_DEFAULTS.fuelRangeKm,
      );
    });
  });

  describe("device-local UI language", () => {
    it("publishes an immediate override and pending account marker", () => {
      usePreferencesStore.getState().selectUiLocale("en", "rider-a");

      expect(usePreferencesStore.getState()).toMatchObject({
        uiLocaleOverride: "en",
        pendingUiLocaleSync: {
          locale: "en",
          ownerUserId: "rider-a",
        },
      });
    });

    it("keeps the durable override after clearing its pending marker", () => {
      usePreferencesStore.getState().selectUiLocale("en");
      usePreferencesStore.getState().completeUiLocaleSync("en");

      expect(usePreferencesStore.getState()).toMatchObject({
        uiLocaleOverride: "en",
        pendingUiLocaleSync: null,
      });
    });

    it("adopts an account locale only when no local write is pending", () => {
      usePreferencesStore.getState().selectUiLocale("en");
      usePreferencesStore.getState().adoptAccountUiLocale("en");
      expect(usePreferencesStore.getState().pendingUiLocaleSync).toEqual({
        locale: "en",
        ownerUserId: null,
      });

      usePreferencesStore.getState().completeUiLocaleSync("en");
      usePreferencesStore.getState().adoptAccountUiLocale("en");
      expect(usePreferencesStore.getState()).toMatchObject({
        uiLocaleOverride: "en",
        pendingUiLocaleSync: null,
      });
    });

    it("does not clear another rider's pending selection", () => {
      usePreferencesStore.getState().selectUiLocale("en", "rider-a");

      usePreferencesStore.getState().completeUiLocaleSync("en", "rider-b");

      expect(usePreferencesStore.getState().pendingUiLocaleSync).toEqual({
        locale: "en",
        ownerUserId: "rider-a",
      });
    });
  });
});

function useStoreReset() {
  usePreferencesStore.setState({
    minQuality: PREFERENCES_DEFAULTS.minQuality,
    fuelRangeKm: PREFERENCES_DEFAULTS.fuelRangeKm,
    weatherAlertsEnabled: PREFERENCES_DEFAULTS.weatherAlertsEnabled,
    uiLocaleOverride: null,
    pendingUiLocaleSync: null,
  });
}
