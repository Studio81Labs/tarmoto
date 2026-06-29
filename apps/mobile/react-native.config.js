/**
 * React Native asset linking — picks up the bundled TF Lite road-surface
 * classifier (US-3) and any future asset folders. The native loader in
 * `react-native-fast-tflite` resolves the metro asset URL through this
 * registration.
 *
 * `./assets/fonts` carries ONLY the four static-weight brand faces
 * (`SpaceGrotesk[/_bold].ttf`, `JetBrainsMono[/_bold].ttf`) — Regular(400) +
 * Bold(700) instanced from the variable sources, named so Android resolves by
 * basename and iOS by the matching internal family. This entry tells
 * `npx react-native-asset` what to copy into the native projects; running that
 * linker, `pod install`, and an on-device check are the remaining dev-machine
 * work (see `assets/fonts/README.md`).
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
