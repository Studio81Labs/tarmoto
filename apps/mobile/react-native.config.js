/**
 * React Native asset linking — picks up the bundled TF Lite road-surface
 * classifier (US-3) and any future asset folders. The native loader in
 * `react-native-fast-tflite` resolves the metro asset URL through this
 * registration.
 */
module.exports = {
  assets: ["./assets/ml"],
};
