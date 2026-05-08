/**
 * Device-family encoding for the on-device road-surface classifier
 * (issue #494).
 *
 * Accelerometer characteristics vary by phone model, mounting position
 * and case. Without an explicit device feature the model conflates
 * "this is a noisy device" with "this is a rough road" and aggregations
 * end up biased per-bucket. The training pipeline buckets riders by
 * device family and either feeds the bucket as an input feature or
 * learns a per-device offset on top of a shared backbone — same vocab
 * either way, so the encoder lives in `@tarmoto/shared` and is reused
 * by the mobile feature packer and the backend analytics pipeline.
 *
 * The list is intentionally coarse: hundreds of phone models share a
 * sensor stack and an MEMS package, and a model with one feature per
 * exact `device_model` would either over-fit or starve the buckets.
 * Five buckets cover the dominant motorcycle-rider phone families and
 * the inevitable long tail in `other`.
 */

export const DEVICE_FAMILIES = [
  "iphone_pro",
  "iphone_standard",
  "pixel",
  "samsung_galaxy_s",
  "other",
] as const;

export type DeviceFamily = (typeof DEVICE_FAMILIES)[number];

/**
 * Map a free-form device model string (the value `react-native-device-
 * info`'s `getModel()` returns, or whatever the backend received in
 * `surface_readings.device_model`) to one of the five canonical
 * families.
 *
 * Matching is case-insensitive and uses substring tokens rather than
 * exact equality so a future model name (`iPhone 17 Pro Max`,
 * `Pixel 11`, `SM-S941U`) lands in the right bucket without a code
 * change. Unknown / null / empty inputs fall through to `other` —
 * we never want to drop a row from the analytics pipeline because the
 * encoder threw on a missing string.
 */
export function encodeDeviceFamily(
  model: string | null | undefined,
): DeviceFamily {
  if (!model) return "other";
  const normalized = model.toLowerCase();

  if (normalized.includes("iphone")) {
    // "iPhone 15 Pro", "iPhone 15 Pro Max", "iPhone 14 Pro" — Pro tier
    // gets its own bucket because the U2 / U2 ultra-wideband chip plus
    // the Pro-tier IMU package have measurably lower accelerometer
    // noise floors than the standard tier.
    return normalized.includes("pro") ? "iphone_pro" : "iphone_standard";
  }
  if (normalized.includes("pixel")) {
    return "pixel";
  }
  // Samsung Galaxy S-series. Match on the marketing name AND the
  // `SM-S###`/`SM-G###` model codes the OS surfaces on Android — the
  // latter is what `Build.MODEL` returns on a stock ROM.
  if (normalized.includes("galaxy s") || /^sm-[sg]\d/.test(normalized)) {
    return "samsung_galaxy_s";
  }
  return "other";
}

/**
 * One-hot encode a device family into a fixed-length vector matching
 * the order of {@link DEVICE_FAMILIES}. Width is `DEVICE_FAMILIES.length`
 * — change to the constant ripples through the model contract, which
 * is the right cross-check (a new bucket needs a model retrain).
 *
 * Returns numbers, not Float32Array, so the helper is usable from both
 * the mobile feature packer (which copies into a `Float32Array` for
 * inference) and the backend analytics pipeline (which writes plain
 * JSON). `Float32Array` would force the consumer to copy anyway.
 */
export function oneHotDeviceFamily(family: DeviceFamily): number[] {
  return DEVICE_FAMILIES.map((f) => (f === family ? 1 : 0));
}
