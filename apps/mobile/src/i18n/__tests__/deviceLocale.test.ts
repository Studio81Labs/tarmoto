import { NativeModules, Platform } from "react-native";
import { detectDeviceFormatLocale, detectDeviceLocale } from "../deviceLocale";

const originalOS = Platform.OS;
const nativeModules = NativeModules as Record<string, unknown>;
const originalSettingsManager = nativeModules.SettingsManager;
const originalI18nManager = nativeModules.I18nManager;

function setPlatform(os: "ios" | "android") {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: os,
  });
}

describe("detectDeviceLocale", () => {
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: originalOS,
    });
    nativeModules.SettingsManager = originalSettingsManager;
    nativeModules.I18nManager = originalI18nManager;
  });

  it("reads the preferred iOS language", () => {
    setPlatform("ios");
    nativeModules.SettingsManager = {
      settings: { AppleLanguages: ["cs-CZ", "en-US"] },
    };

    expect(detectDeviceLocale()).toBe("cs-CZ");
  });

  it("keeps the preferred language separate from the regional format locale", () => {
    setPlatform("ios");
    nativeModules.SettingsManager = {
      settings: {
        AppleLanguages: ["cs_CZ", "en-US"],
        AppleLocale: "en_US",
      },
    };

    expect(detectDeviceLocale()).toBe("cs-CZ");
    expect(detectDeviceFormatLocale()).toBe("en-US");
  });

  it("normalizes the iOS locale separator", () => {
    setPlatform("ios");
    nativeModules.SettingsManager = {
      settings: { AppleLocale: "cs_CZ" },
    };

    expect(detectDeviceLocale()).toBe("cs-CZ");
    expect(detectDeviceFormatLocale()).toBe("cs-CZ");
  });

  it("normalizes the Android locale separator", () => {
    setPlatform("android");
    nativeModules.I18nManager = { localeIdentifier: "cs_CZ" };

    expect(detectDeviceLocale()).toBe("cs-CZ");
    expect(detectDeviceFormatLocale()).toBe("cs-CZ");
  });
});
