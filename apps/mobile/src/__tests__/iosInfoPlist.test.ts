import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SUPPORTED_LOCALES } from "@tarmoto/shared";

const USAGE_DESCRIPTION_KEYS = [
  "NSLocationWhenInUseUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSCameraUsageDescription",
  "NSPhotoLibraryUsageDescription",
  "NSMotionUsageDescription",
] as const;

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
    if (!m || m[1] === undefined) throw new Error(`missing key ${key}`);
    return m[1];
  }

  it.each(USAGE_DESCRIPTION_KEYS)("%s is set and non-empty", (key) => {
    const value = valueOf(key);
    expect(value.trim().length).toBeGreaterThan(20);
  });

  it.each(SUPPORTED_LOCALES)(
    "ships localized permission copy for %s",
    (locale) => {
      const stringsPath = join(
        __dirname,
        `../../ios/TarmotoApp/${locale}.lproj/InfoPlist.strings`,
      );
      expect(existsSync(stringsPath)).toBe(true);
      const strings = readFileSync(stringsPath, "utf8");
      for (const key of USAGE_DESCRIPTION_KEYS) {
        expect(strings).toMatch(
          new RegExp(`^"${key}"\\s*=\\s*"[^"\\n]{20,}";`, "m"),
        );
      }
    },
  );

  it("includes the localized Info.plist table in the Xcode resources phase", () => {
    const project = readFileSync(
      join(__dirname, "../../ios/TarmotoApp.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(project).toMatch(/InfoPlist\.strings in Resources/);
    for (const locale of SUPPORTED_LOCALES) {
      expect(project).toContain(
        `path = TarmotoApp/${locale}.lproj/InfoPlist.strings`,
      );
    }
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
