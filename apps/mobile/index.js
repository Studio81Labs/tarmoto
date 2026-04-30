import { AppRegistry } from "react-native";
import App from "./App";
import AndroidAutoEntry from "./src/components/AndroidAutoEntry";

AppRegistry.registerComponent("TarmotoApp", () => App);

// US-17 — Android Auto entry point.
// react-native-carplay's CarPlaySession on Android calls
// `AppRegistry.runApplication("AndroidAuto", ...)` when the head unit
// connects, before it calls our setRootTemplate / pushTemplate bridge
// methods. Registering a component named "AndroidAuto" is what unblocks
// that runApplication call so the JS context is reachable from the car
// task; without it the head unit shows "App is not responding".
//
// The component itself doesn't render onto the head unit display — AA
// renders native templates exclusively. We register a tiny invisible
// surface whose only job is to keep the JS context warm so the carplay
// / vehicleDisplay services can drive the templates from the phone-side
// React tree.
AppRegistry.registerComponent("AndroidAuto", () => AndroidAutoEntry);
