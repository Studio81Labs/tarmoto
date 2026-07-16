import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFormatPrefs } from "./server";

// vi.hoisted so the mock factory's state exists when vi.mock is hoisted
// above the imports — a plain top-level const would hit the TDZ.
const state = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  acceptLanguage: null as string | null,
  throwCookies: false,
  throwHeaders: false,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.throwCookies) {
      throw new Error("cookies() unavailable");
    }
    return {
      get: (name: string) => {
        const value = state.cookieJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    };
  },
  headers: async () => {
    if (state.throwHeaders) {
      throw new Error("headers() unavailable");
    }
    return {
      get: (name: string) =>
        name.toLowerCase() === "accept-language" ? state.acceptLanguage : null,
    };
  },
}));

describe("readFormatPrefs", () => {
  beforeEach(() => {
    state.cookieJar.clear();
    state.acceptLanguage = null;
    state.throwCookies = false;
    state.throwHeaders = false;
  });

  it("prefers valid cookies", async () => {
    state.cookieJar.set("tarmoto-format-locale", "cs-CZ");
    state.cookieJar.set("tarmoto-timezone", "Europe/Prague");
    state.cookieJar.set("tarmoto-units", "imperial");
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "cs-CZ",
      timeZone: "Europe/Prague",
      units: "imperial",
    });
  });

  it("falls back to the full Accept-Language tag when the locale cookie is absent", async () => {
    state.acceptLanguage = "de-AT,de;q=0.9,en;q=0.8";
    const prefs = await readFormatPrefs();
    expect(prefs.formatLocale).toBe("de-AT");
  });

  it("ignores tampered cookies and falls back to defaults", async () => {
    state.cookieJar.set("tarmoto-format-locale", "!!bad!!");
    state.cookieJar.set("tarmoto-timezone", "Mars/Olympus_Mons");
    state.cookieJar.set("tarmoto-units", "cubits");
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("defaults to en/UTC/metric with nothing to go on", async () => {
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("falls back to Accept-Language when cookies() throws", async () => {
    state.throwCookies = true;
    state.acceptLanguage = "de-AT,de;q=0.9,en;q=0.8";
    const prefs = await readFormatPrefs();
    expect(prefs).toEqual({
      formatLocale: "de-AT",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("defaults to en/UTC/metric when both cookies() and headers() throw", async () => {
    state.throwCookies = true;
    state.throwHeaders = true;
    await expect(readFormatPrefs()).resolves.toEqual({
      formatLocale: "en",
      timeZone: "UTC",
      units: "metric",
    });
  });
});
