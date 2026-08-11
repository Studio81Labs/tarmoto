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

  function localizedValue(strings: string, key: string): string {
    const match = strings.match(
      new RegExp(`^"${key}"\\s*=\\s*"([^"\\n]+)";`, "m"),
    );
    if (!match?.[1]) throw new Error(`missing localized key ${key}`);
    return match[1];
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
      const englishStrings = readFileSync(
        join(__dirname, "../../ios/TarmotoApp/en.lproj/InfoPlist.strings"),
        "utf8",
      );
      for (const key of USAGE_DESCRIPTION_KEYS) {
        expect(strings).toMatch(
          new RegExp(`^"${key}"\\s*=\\s*"[^"\\n]{20,}";`, "m"),
        );
        if (locale !== "en") {
          expect(localizedValue(strings, key)).not.toBe(
            localizedValue(englishStrings, key),
          );
        }
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

  /**
   * CarPlay makes this a scene-based app. Once a scene manifest exists UIKit
   * stops adopting `UIApplicationDelegate.window`, so the phone window role
   * MUST also be declared with a delegate to create and attach the window —
   * without it the scene comes up with no windows, the React surface lays out
   * at zero width, and the app launches to a black screen.
   */
  it("declares both the phone window scene and the CarPlay scene", () => {
    const block = plist.match(
      /<key>UISceneConfigurations<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*<\/dict>/,
    );
    expect(block).toBeTruthy();
    const inner = block![1]!;

    expect(inner).toContain("UIWindowSceneSessionRoleApplication");
    expect(inner).toContain("CPTemplateApplicationSceneSessionRoleApplication");

    const delegateFor = (role: string): string => {
      const match = inner.match(
        new RegExp(
          `<key>${role}</key>\\s*<array>[\\s\\S]*?<key>UISceneDelegateClassName</key>\\s*<string>([^<]+)</string>`,
        ),
      );
      if (!match?.[1]) throw new Error(`missing scene delegate for ${role}`);
      return match[1];
    };

    expect(delegateFor("UIWindowSceneSessionRoleApplication")).toBe(
      "SceneDelegate",
    );
    expect(
      delegateFor("CPTemplateApplicationSceneSessionRoleApplication"),
    ).toBe("CarSceneDelegate");
  });

  /**
   * The window scene delegate named above has to exist under that exact
   * Objective-C name, otherwise UIKit silently fails to instantiate it and the
   * scene connects with no delegate — the same black screen.
   */
  it("implements the declared window scene delegate", () => {
    const appDelegate = readFileSync(
      join(__dirname, "../../ios/TarmotoApp/AppDelegate.swift"),
      "utf8",
    );
    expect(appDelegate).toMatch(
      /@objc\(SceneDelegate\)\s*\n\s*class SceneDelegate: UIResponder, UIWindowSceneDelegate/,
    );
    // The window must be bound to its scene; a bare `UIWindow(frame:)` is what
    // produced the zero-width surface.
    expect(appDelegate).toContain("UIWindow(windowScene: windowScene)");
  });

  /**
   * Updating an app does not necessarily recreate its persisted scene sessions.
   * An install whose session predates the window-scene role can be reconnected
   * from its saved configuration without ever instantiating `SceneDelegate`,
   * leaving a live `UIWindowScene` with no window — the same black screen,
   * still there after the update. There has to be a rescue path that does not
   * depend on reinstalling.
   */
  it("adopts a window scene that came up with no window", () => {
    const appDelegate = readFileSync(
      join(__dirname, "../../ios/TarmotoApp/AppDelegate.swift"),
      "utf8",
    );
    expect(appDelegate).toContain("adoptOrphanedWindowSceneIfNeeded");
    // Finds a connected scene that has no windows and attaches one.
    expect(appDelegate).toMatch(/first\(where: \{ \$0\.windows\.isEmpty \}\)/);
    expect(appDelegate).toMatch(
      /UIWindow\(windowScene: orphanedScene\)[\s\S]*?makeKeyAndVisible\(\)/,
    );
  });

  /**
   * Every scene that can be the *only* scene in the process has to be able to
   * start the JS application. iOS can reconnect a persisted `UISceneSession`
   * from its saved configuration and skip `configurationForConnecting`, so
   * bootstrap belongs in the scene delegates themselves — otherwise a restored
   * CarPlay session connects `RNCarPlay` with no JS running and the head unit
   * gets no templates.
   */
  it("starts React Native from CarPlay as well as the phone scene", () => {
    const appDelegate = readFileSync(
      join(__dirname, "../../ios/TarmotoApp/AppDelegate.swift"),
      "utf8",
    );
    // Reachable from Objective-C so CarPlay can call it.
    expect(appDelegate).toMatch(
      /@objc\s*\n\s*func startReactNativeIfNeeded\(\)/,
    );

    const carScene = readFileSync(
      join(__dirname, "../../ios/TarmotoApp/CarSceneDelegate.m"),
      "utf8",
    );
    expect(carScene).toContain("startReactNativeIfNeeded");
    // JS must be up before the interface controller is handed to RNCarPlay.
    expect(
      carScene.indexOf("appDelegate startReactNativeIfNeeded"),
    ).toBeLessThan(carScene.indexOf("connectWithInterfaceController:"));

    // Scene configuration stays with the Info.plist manifest so UIKit's own
    // role lookup wires both delegates, and no app-side override can skip a
    // restored session. Comments are stripped so the prose explaining this
    // does not satisfy the check.
    const code = appDelegate
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("configurationForConnecting");
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
