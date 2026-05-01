import { readFileSync } from "fs";
import { join } from "path";

/**
 * Manifest sanity test for issue #280. Without this guard a rebase or
 * "tidy unused permissions" pass could silently strip the runtime
 * permissions Tarmoto actually requests at runtime, locking riders out
 * of location, sensors, or notifications without a CI signal.
 */
describe("AndroidManifest.xml", () => {
  const xml = readFileSync(
    join(__dirname, "../../android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );

  it.each([
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
    "android.permission.WAKE_LOCK",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.BODY_SENSORS",
  ])("declares %s", (perm) => {
    expect(xml).toMatch(
      new RegExp(`<uses-permission[^/]+android:name="${perm}"`),
    );
  });

  it("declares the GPS hardware feature", () => {
    expect(xml).toMatch(
      /<uses-feature[\s\S]*?android:name="android\.hardware\.location\.gps"/,
    );
  });

  it("keeps the existing Android Auto wiring (merged from react-native-carplay)", () => {
    expect(xml).toMatch(/com\.google\.android\.gms\.car\.application/);
    expect(xml).toMatch(/automotive_app_desc/);
  });
});
