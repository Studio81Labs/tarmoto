import { readFileSync } from "fs";
import { join } from "path";

/**
 * The mobile app's iOS Info.plist is hand-edited XML. Without a guard
 * these regress silently — an empty location string ships and Apple
 * rejects the build only after the upload finishes. A simple string
 * test runs in milliseconds and catches every requirement from
 * issue #280.
 */
describe("iOS Info.plist", () => {
  const plist = readFileSync(
    join(__dirname, "../../ios/TarmotoApp/Info.plist"),
    "utf8",
  );

  function valueOf(key: string): string {
    const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "m");
    const m = plist.match(re);
    if (!m) throw new Error(`missing key ${key}`);
    return m[1];
  }

  it.each([
    "NSLocationWhenInUseUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSCameraUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSMotionUsageDescription",
  ])("%s is set and non-empty", (key) => {
    const value = valueOf(key);
    expect(value.trim().length).toBeGreaterThan(20);
  });

  it("declares the background modes we depend on", () => {
    const block = plist.match(
      /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(block).toBeTruthy();
    const inner = block![1];
    expect(inner).toMatch(/<string>location<\/string>/);
    expect(inner).toMatch(/<string>audio<\/string>/);
    expect(inner).toMatch(/<string>remote-notification<\/string>/);
  });
});
