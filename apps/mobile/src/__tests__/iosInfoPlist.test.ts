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

    // The manifest comment previously asserted the opposite — that declaring
    // the phone role would "collide" and that iOS falls back to
    // AppDelegate-managed windows. That belief is what produced the black
    // screen, so it must not survive next to the config that disproves it.
    expect(plist).not.toMatch(
      /phone window deliberately is NOT declared|falls back to\s*\n?\s*AppDelegate-managed window creation/,
    );
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
    // Declared AND invoked — a definition nothing calls would rescue nobody.
    expect(appDelegate).toMatch(
      /private func adoptOrphanedWindowSceneIfNeeded\(\)/,
    );
    expect(appDelegate).toContain("self.adoptOrphanedWindowSceneIfNeeded()");
    // Finds a connected scene that has no windows and attaches one.
    expect(appDelegate).toMatch(/first\(where: \{ \$0\.windows\.isEmpty \}\)/);
    expect(appDelegate).toMatch(
      /UIWindow\(windowScene: orphanedScene\)[\s\S]*?makeKeyAndVisible\(\)/,
    );

    // The launch backstop is one-shot and a background launch (woken for
    // location or a push) has no scene while it runs. Adoption must be retried
    // when a scene later activates, or foregrounding that same process leaves
    // the black screen until it restarts.
    expect(appDelegate).toContain("UIScene.didActivateNotification");
    const retry = appDelegate.match(
      /@objc\s*\n\s*private func sceneDidActivate\(\)[\s\S]*?\n {2}\}/,
    );
    expect(retry).toBeTruthy();
    expect(retry![0]).toContain("adoptOrphanedWindowSceneIfNeeded()");
    expect(retry![0]).toContain("startReactNativeIfNeeded()");
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
    // Match the invocation, not the protocol declaration — and assert both
    // sites exist before comparing order, or a deleted call would read as
    // index -1 and silently satisfy a "comes first" check.
    const bootstrapCall = carScene.indexOf(
      "[(id<TarmotoReactNativeStarting>)appDelegate startReactNativeIfNeeded];",
    );
    const carPlayConnect = carScene.indexOf("connectWithInterfaceController:");
    expect(bootstrapCall).toBeGreaterThanOrEqual(0);
    expect(carPlayConnect).toBeGreaterThanOrEqual(0);
    // JS must be up before the interface controller is handed to RNCarPlay.
    expect(bootstrapCall).toBeLessThan(carPlayConnect);

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
