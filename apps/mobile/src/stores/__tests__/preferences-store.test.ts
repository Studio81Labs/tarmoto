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
});

function useStoreReset() {
  usePreferencesStore.setState({ minQuality: PREFERENCES_DEFAULTS.minQuality });
}
