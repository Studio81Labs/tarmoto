import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "./constants";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  acceptLanguage: null as string | null,
  accountLanguage: null as "en" | null,
}));

const authMock = vi.hoisted(() => vi.fn());
const headersMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: headersMock,
}));

import { readLocale } from "./server";

// Mirrors ACCOUNT_LOCALE_LOOKUP_TIMEOUT_MS without exporting an internal
// implementation detail from the server locale module.
const ACCOUNT_LOCALE_LOOKUP_TIMEOUT_MS = 3000;

describe("server locale resolution", () => {
  beforeEach(() => {
    state.cookies.clear();
    state.acceptLanguage = null;
    state.accountLanguage = null;
    authMock.mockReset();
    headersMock.mockReset();
    authMock.mockImplementation(async () =>
      state.accountLanguage
        ? { user: { language: state.accountLanguage } }
        : null,
    );
    headersMock.mockImplementation(async () => ({
      get: (name: string) =>
        name.toLowerCase() === "accept-language" ? state.acceptLanguage : null,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a valid explicit cookie precedence over account and browser state", async () => {
    state.cookies.set(LOCALE_COOKIE, "en-GB");
    state.accountLanguage = "en";
    state.acceptLanguage = "en;q=0";

    await expect(readLocale()).resolves.toBe("en");
    expect(authMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
  });

  it("uses the authenticated account language before Accept-Language", async () => {
    state.accountLanguage = "en";
    state.acceptLanguage = "en;q=0";

    await expect(readLocale()).resolves.toBe("en");
    expect(authMock).toHaveBeenCalledOnce();
    expect(headersMock).not.toHaveBeenCalled();
  });

  it("falls through invalid cookies and anonymous sessions to browser detection", async () => {
    state.cookies.set(LOCALE_COOKIE, "xx");
    state.acceptLanguage = "en-GB";

    await expect(readLocale()).resolves.toBe("en");
    expect(authMock).toHaveBeenCalledOnce();
    expect(headersMock).toHaveBeenCalledOnce();
  });

  it("bounds a hanging auth refresh and falls through to browser detection", async () => {
    vi.useFakeTimers();
    state.acceptLanguage = "en-GB";
    authMock.mockReturnValueOnce(new Promise(() => {}));

    const localePromise = readLocale();
    await vi.advanceTimersByTimeAsync(0);
    expect(authMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(ACCOUNT_LOCALE_LOOKUP_TIMEOUT_MS + 1);

    await expect(localePromise).resolves.toBe("en");
    expect(headersMock).toHaveBeenCalledOnce();
  });
});
