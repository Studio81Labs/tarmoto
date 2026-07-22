import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { HAZARD_TYPES, SUPPORTED_LOCALES } from "@tarmoto/shared";

function androidValuesDirectory(locale: string): string {
  if (locale === "en") return "values";
  const [language, ...subtags] = locale.split("-");
  return subtags.length === 0
    ? `values-${language}`
    : `values-b+${[language, ...subtags].join("+")}`;
}

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

  it("wires the App Actions shortcuts.xml on the main activity (#343)", () => {
    // Without this meta-data the Assistant can't discover the
    // REPORT_HAZARD capability — voice queries silently fall back to
    // a generic web search and the rider thinks Tarmoto is broken.
    expect(xml).toMatch(
      /<meta-data[\s\S]*?android:name="android\.app\.shortcuts"[\s\S]*?android:resource="@xml\/shortcuts"/,
    );
  });
});

/**
 * App Actions inventory guard (#343). Each canonical hazard type in
 * `@tarmoto/shared` must appear as a `<shortcut>` capability-binding
 * in `shortcuts.xml` and as a synonym `<string-array>` in
 * `arrays.xml`, otherwise the Assistant either rejects the voice
 * query or fires a deep link with a hazard type the React Navigation
 * parser then drops.
 */
describe("Android App Actions wiring", () => {
  const shortcuts = readFileSync(
    join(__dirname, "../../android/app/src/main/res/xml/shortcuts.xml"),
    "utf8",
  );
  const arrays = readFileSync(
    join(__dirname, "../../android/app/src/main/res/values/arrays.xml"),
    "utf8",
  );

  it("declares the REPORT_HAZARD capability with the deep-link URL template", () => {
    expect(shortcuts).toMatch(
      /android:name="custom\.actions\.intent\.REPORT_HAZARD"/,
    );
    expect(shortcuts).toMatch(
      /android:value="tarmoto:\/\/hazard\/report\{\?preselectedType\}"/,
    );
    // Targeting MainActivity directly so the deep link lands on the JS
    // entry that owns React Navigation's linking; sending it elsewhere
    // would either crash on AA or open a blank screen.
    expect(shortcuts).toMatch(
      /android:targetClass="app\.tarmoto\.MainActivity"/,
    );
  });

  it.each(HAZARD_TYPES)(
    "binds the %s hazard type to a synonym inventory",
    (type) => {
      expect(shortcuts).toMatch(
        new RegExp(`android:value="@array/hazard_${type}_synonyms"`),
      );
      expect(arrays).toMatch(
        new RegExp(
          `<string-array name="hazard_${type}_synonyms"[\\s\\S]*?<item>${type}</item>`,
        ),
      );
    },
  );

  it("keeps Assistant synonym inventories translatable", () => {
    expect(arrays).not.toContain('translatable="false"');
  });

  it.each(SUPPORTED_LOCALES)(
    "ships App Actions labels and phrases for %s",
    (locale) => {
      const resourceDir = join(
        __dirname,
        "../../android/app/src/main/res",
        androidValuesDirectory(locale),
      );
      const stringsPath = join(resourceDir, "strings.xml");
      const arraysPath = join(resourceDir, "arrays.xml");
      expect(existsSync(stringsPath)).toBe(true);
      expect(existsSync(arraysPath)).toBe(true);

      const localizedStrings = readFileSync(stringsPath, "utf8");
      const localizedArrays = readFileSync(arraysPath, "utf8");
      for (const type of HAZARD_TYPES) {
        expect(localizedStrings).toContain(`name="hazard_${type}_label"`);
        expect(localizedArrays).toContain(`name="hazard_${type}_synonyms"`);
      }
    },
  );

  it.each(HAZARD_TYPES)(
    "uses the canonical %s string as the shortcutId",
    (type) => {
      // App Actions inline inventory substitutes the **shortcutId**
      // (not the matched synonym) into the URL template parameter,
      // so the id MUST equal the canonical hazard-type string in
      // `HAZARD_TYPES`. A prefixed id (e.g. "hazard_pothole") would
      // arrive at `parseHazardTypeParam` as an unknown value and the
      // voice flow would silently fall back to no-preselection.
      // This regex matches a `<shortcut>` element whose shortcutId
      // is exactly `type` and whose capability-binding ties back to
      // the matching synonym array — guarding against both halves
      // of the wiring drifting apart.
      expect(shortcuts).toMatch(
        new RegExp(
          `<shortcut[\\s\\S]*?android:shortcutId="${type}"[\\s\\S]*?@array/hazard_${type}_synonyms`,
        ),
      );
    },
  );
});
