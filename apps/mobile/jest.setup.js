/**
 * Global Jest setup for the mobile app.
 *
 * React Testing Library renders components without the app's
 * `SafeAreaProvider`, so `useSafeAreaInsets()` throws ("No safe area value
 * available"). Mock the library to return zero insets in tests — screens that
 * pad by the bottom inset (e.g. the immersive ride HUD / nav) then render with
 * the no-inset fallback, which matches the assertion-relevant layout.
 */
jest.mock("react-native-safe-area-context", () => {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaConsumer: ({ children }) => children(inset),
    SafeAreaView: ({ children }) => children,
    SafeAreaInsetsContext: {
      Provider: ({ children }) => children,
      Consumer: ({ children }) => children(inset),
    },
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets: inset, frame },
  };
});

jest.mock("react-native-permissions", () =>
  require("react-native-permissions/mock"),
);

/**
 * In-memory keychain fake (per service name), cleared between tests. The
 * auth token pair lives here since #1231; `typedClient` imports the module
 * at eval time, so the mock must exist globally like the MMKV one below.
 */
jest.mock("react-native-keychain", () => {
  const entries = new Map();
  const fake = {
    ACCESSIBLE: { AFTER_FIRST_UNLOCK: "AccessibleAfterFirstUnlock" },
    setGenericPassword: jest.fn(async (username, password, options) => {
      entries.set(options?.service ?? "default", { username, password });
      return { service: options?.service ?? "default", storage: "fake" };
    }),
    getGenericPassword: jest.fn(async (options) => {
      const entry = entries.get(options?.service ?? "default");
      return entry
        ? { ...entry, service: options?.service ?? "default", storage: "fake" }
        : false;
    }),
    resetGenericPassword: jest.fn(async (options) => {
      entries.delete(options?.service ?? "default");
      return true;
    }),
    // This file runs as `setupFiles` (before the test framework), so no
    // beforeEach here — tests that assert on keychain state clear the fake
    // themselves via this handle.
    __entriesForTest: entries,
  };
  return fake;
});
