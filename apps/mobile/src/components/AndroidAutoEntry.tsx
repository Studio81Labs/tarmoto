/**
 * AndroidAutoEntry — US-17.
 *
 * Marker component referenced by the `AppRegistry.registerComponent(
 * "AndroidAuto", ...)` call in `index.js`. The Android side of
 * react-native-carplay invokes that registered application when the head
 * unit connects so the JS context is alive when the car task starts
 * pushing templates.
 *
 * Android Auto renders native templates exclusively (Pane, Map, Search,
 * etc. via androidx.car.app). The phone-side React tree never paints onto
 * the head unit, so this entry returns null. The actual template surface
 * is driven by `services/carplay.ts` and `services/vehicleDisplay.ts` —
 * those services run inside the same JS context this entry keeps warm.
 *
 * Keeping this file pure-React (no native imports) means it's safe to
 * load on iOS too, where it's a no-op since `index.js`'s registration
 * never fires the AndroidAuto runApplication path.
 */

export default function AndroidAutoEntry(): null {
  return null;
}
