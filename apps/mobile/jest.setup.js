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
