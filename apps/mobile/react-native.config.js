/**
 * React Native asset linking — picks up the bundled TF Lite road-surface
 * classifier (US-3) and any future asset folders. The native loader in
 * `react-native-fast-tflite` resolves the metro asset URL through this
 * registration.
 *
 * `./assets/fonts` carries ONLY the static-weight brand faces instanced from
 * the variable sources — JetBrains Mono at 400/500/600/700/800 and Space
 * Grotesk at 400/500/600/700 (its `wght` axis caps at 700, so no 800). They're
 * named so Android resolves the Regular/Bold pair by basename and iOS matches
 * the rest by their internal family + `usWeightClass`.
 *
 * The native artifacts from `npx react-native-asset` are committed: the iOS
 * `UIAppFonts` + Copy Bundle Resources refs (`TarmotoApp/Info.plist`,
 * `TarmotoApp.xcodeproj`) and the Android `app/src/main/assets/fonts/` copies.
 * Re-run the linker only after adding/removing a face. Remaining dev-machine
 * work: `cd ios && pod install`, Android weight-aware wiring for 500/600/800,
 * and an on-device render check (see `assets/fonts/README.md`).
 *
 * NOTE: `./assets/ml` is listed for completeness but was deliberately NOT
 * linked into the native projects — the TF Lite classifier is Metro-bundled
 * and loaded via `react-native-fast-tflite`, so a native copy would just
 * duplicate the model in the binary. If you re-run `react-native-asset`, scope
 * it to fonts (or drop the ml native copies it produces).
 *
 * The variable-font sources deliberately live OUTSIDE this linked root, in
 * `assets/font-sources/` — `react-native-asset` walks the asset root
 * recursively, so a `.ttf` left anywhere under `./assets/fonts` would be
 * linked too. That matters: the variable JetBrains Mono shares the
 * `JetBrainsMono-Regular` PostScript name with the generated static Regular,
 * so linking both would collide on iOS and drop `fontFamily: "JetBrainsMono"`
 * back to a system fallback.
 */
module.exports = {
  assets: ["./assets/ml", "./assets/fonts"],
};
