/**
 * React Native asset linking — picks up the bundled TF Lite road-surface
 * classifier (US-3) and any future asset folders. The native loader in
 * `react-native-fast-tflite` resolves the metro asset URL through this
 * registration.
 *
 * `assets/fonts` carries the brand typefaces (Space Grotesk, JetBrains
 * Mono — see `assets/fonts/README.md`). `npx react-native-asset` copies
 * the `.ttf` files into the iOS bundle / `android/app/src/main/assets/fonts`
 * and registers them, so `fontFamily: "Space Grotesk" | "JetBrains Mono"`
 * resolves on both platforms after a native rebuild.
 */
module.exports = {
  assets: ["./assets/ml", "./assets/fonts"],
};
