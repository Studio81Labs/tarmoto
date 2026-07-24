import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { PreferencesSync } from "./PreferencesSync";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api/users";
import { LOCALE_COOKIE, LOCALE_SYNC_PENDING_COOKIE } from "@/i18n";

let sessionStatus = "authenticated";
const refresh = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: sessionStatus }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>();
  return {
    ...actual,
    // Exercise the future-locale reconciliation path while production still
    // intentionally exposes English only.
    isSupportedLocale: (locale: string) => locale === "en" || locale === "cs",
  };
});
vi.mock("@/lib/api/users", () => ({
  usersApi: { getMe: vi.fn(), updateMe: vi.fn() },
}));

const getMe = vi.mocked(usersApi.getMe);
const updateMe = vi.mocked(usersApi.updateMe);

// The component reads the device the same way FormatPrefsSync does; pin the
// locale and read the jsdom timezone so assertions hold on any host.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function meWithPreferences(
  preferences: Record<string, unknown>,
  language?: string,
) {
  // usersApi.getMe() resolves to `{ data: UserProfileResponse }` (see
  // openApiData in lib/api/client.ts) — nest under `data` so the mock
  // matches the real contract the component destructures against.
  return { data: { preferences, language } } as unknown as Awaited<
    ReturnType<typeof usersApi.getMe>
  >;
}

/** Account state already fully mirroring this device (no PATCH expected). */
function convergedPreferences(extra: Record<string, unknown> = {}) {
  return { format_locale: "cs-CZ", timezone: DEVICE_TZ, ...extra };
}

describe("PreferencesSync", () => {
  beforeEach(() => {
    sessionStatus = "authenticated";
    getMe.mockReset();
    updateMe.mockReset();
    refresh.mockReset();
    updateMe.mockResolvedValue(meWithPreferences({}));
    Object.defineProperty(window.navigator, "language", {
      value: "cs-CZ",
      configurable: true,
    });
    window.localStorage.clear();
    document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
    document.cookie = `${LOCALE_SYNC_PENDING_COOKIE}=; path=/; max-age=0`;
    act(() => {
      usePreferencesStore.setState({ unitSystem: "metric", hydrated: false });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("account units win over the local store", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "imperial" })),
    );

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().unitSystem).toBe("imperial"),
    );
    expect(updateMe).not.toHaveBeenCalled();
    // The account choice is now the device's explicit choice too.
    expect(window.localStorage.getItem("tarmoto:preferences:unit-system")).toBe(
      "imperial",
    );
  });

  it("backfills an explicit pre-account localStorage units value once", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "imperial");
    getMe.mockResolvedValueOnce(meWithPreferences(convergedPreferences()));

    render(<PreferencesSync />);

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({
      preferences: { units: "imperial" },
    });
  });

  it("prefills format prefs when the record lacks them (cookies may already match)", async () => {
    getMe.mockResolvedValueOnce(meWithPreferences({ units: "metric" }));
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    render(<PreferencesSync />);

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({
      preferences: { format_locale: "cs-CZ", timezone: DEVICE_TZ },
    });
  });

  it("retries an explicitly pending locale that did not reach the account record", async () => {
    document.cookie = `${LOCALE_COOKIE}=en; path=/`;
    document.cookie = `${LOCALE_SYNC_PENDING_COOKIE}=en; path=/`;
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "metric" })),
    );
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    render(<PreferencesSync />);

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    expect(updateMe).toHaveBeenCalledWith({ language: "en" });
    expect(document.cookie).not.toContain(`${LOCALE_SYNC_PENDING_COOKIE}=`);
  });

  it("does not let an ordinary stale cookie overwrite a newer account language", async () => {
    document.cookie = `${LOCALE_COOKIE}=en; path=/`;
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "metric" }), "cs"),
    );
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    render(<PreferencesSync />);

    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
    expect(updateMe).not.toHaveBeenCalled();
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=cs`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("clears a pending marker when the account already matches it", async () => {
    document.cookie = `${LOCALE_COOKIE}=en; path=/`;
    document.cookie = `${LOCALE_SYNC_PENDING_COOKIE}=en; path=/`;
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "metric" }), "en"),
    );
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    render(<PreferencesSync />);

    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
    expect(updateMe).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(`${LOCALE_SYNC_PENDING_COOKIE}=`);
  });

  it("writes nothing when the record already mirrors the device", async () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");
    getMe.mockResolvedValueOnce(
      meWithPreferences(convergedPreferences({ units: "metric" })),
    );

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().hydrated).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("skips account sync entirely when unauthenticated", async () => {
    sessionStatus = "unauthenticated";

    render(<PreferencesSync />);

    await waitFor(() =>
      expect(usePreferencesStore.getState().hydrated).toBe(true),
    );
    expect(getMe).not.toHaveBeenCalled();
  });

  it("does not re-run the reconciliation on a later authenticated status flip", async () => {
    // Regression: strict-mode double-invoke and repeat "authenticated"
    // passes (e.g. a background session-refresh re-render) each re-ran
    // the full /me GET+PATCH cycle. Simulate a status flip away from and
    // back to "authenticated" on an already-mounted instance and confirm
    // the reconciliation only ever fires once.
    getMe.mockResolvedValueOnce(meWithPreferences(convergedPreferences()));
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    const { rerender } = render(<PreferencesSync />);
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));

    sessionStatus = "loading";
    rerender(<PreferencesSync />);
    sessionStatus = "authenticated";
    rerender(<PreferencesSync />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh reconciliation after a real logout and new login", async () => {
    getMe.mockResolvedValue(
      meWithPreferences(convergedPreferences({ units: "metric" })),
    );
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");

    const view = await render(<PreferencesSync />);
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));

    sessionStatus = "unauthenticated";
    await view.rerender(<PreferencesSync />);
    sessionStatus = "authenticated";
    await view.rerender(<PreferencesSync />);

    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(2));
  });

  it("retries transient synchronization failures while the component stays mounted", async () => {
    vi.useFakeTimers();
    document.cookie = `${LOCALE_COOKIE}=en; path=/`;
    document.cookie = `${LOCALE_SYNC_PENDING_COOKIE}=en; path=/`;
    getMe.mockResolvedValue(
      meWithPreferences(convergedPreferences({ units: "metric" })),
    );
    window.localStorage.setItem("tarmoto:preferences:unit-system", "metric");
    updateMe
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(meWithPreferences({}));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<PreferencesSync />);

    await vi.waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(updateMe).toHaveBeenCalledTimes(2));
    expect(document.cookie).not.toContain(`${LOCALE_SYNC_PENDING_COOKIE}=`);

    errorSpy.mockRestore();
  });

  it("ignores a stale account read when a local unit change raced it", async () => {
    let resolveMe!: (value: Awaited<ReturnType<typeof usersApi.getMe>>) => void;
    getMe.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMe = resolve;
      }),
    );

    render(<PreferencesSync />);
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));

    // The rider flips units while the initial /me read is still in flight —
    // the settings toggle's own PATCH persists the new choice separately.
    act(() => {
      usePreferencesStore.getState().setUnitSystem("imperial");
    });

    // The in-flight read resolves with the PRE-toggle account value. Applying
    // it would revert the rider's just-made choice, and `ran` blocks any
    // later in-session reconciliation from healing the split.
    await act(async () => {
      resolveMe(meWithPreferences(convergedPreferences({ units: "metric" })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(usePreferencesStore.getState().unitSystem).toBe("imperial");
    expect(updateMe).not.toHaveBeenCalled();
  });
});
