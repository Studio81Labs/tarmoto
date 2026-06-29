/**
 * React Native asset linking — picks up the bundled TF Lite road-surface
 * classifier (US-3) and any future asset folders. The native loader in
 * `react-native-fast-tflite` resolves the metro asset URL through this
 * registration.
 *
 * `./assets/fonts` carries the four static-weight brand faces
 * (`SpaceGrotesk[/_bold].ttf`, `JetBrainsMono[/_bold].ttf`) — Regular(400) +
 * Bold(700) instanced from the variable sources, named so Android resolves by
 * basename and iOS by the matching internal family. This entry tells
 * `npx react-native-asset` what to copy into the native projects; running that
 * linker, `pod install`, and an on-device check are the remaining dev-machine
 * work (see `assets/fonts/README.md`). The variable-font sources live in
 * `assets/fonts/variable-src/` so they're kept for re-instancing but not
 * copied into the app bundle.
 */
module.exports = {
  assets: ["./assets/ml", "./assets/fonts"],
};
