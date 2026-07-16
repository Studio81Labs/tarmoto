import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { PreferencesSync } from "./PreferencesSync";
import { usePreferencesStore } from "@/stores/preferences";
import { usersApi } from "@/lib/api/users";

let sessionStatus = "authenticated";
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: sessionStatus }),
}));
vi.mock("@/lib/api/users", () => ({
  usersApi: { getMe: vi.fn(), updateMe: vi.fn() },
}));

const getMe = vi.mocked(usersApi.getMe);
const updateMe = vi.mocked(usersApi.updateMe);

// The component reads the device the same way FormatPrefsSync does; pin the
// locale and read the jsdom timezone so assertions hold on any host.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function meWithPreferences(preferences: Record<string, unknown>) {
  // usersApi.getMe() resolves to `{ data: UserProfileResponse }` (see
  // openApiData in lib/api/client.ts) — nest under `data` so the mock
  // matches the real contract the component destructures against.
  return { data: { preferences } } as unknown as Awaited<
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
    updateMe.mockResolvedValue(meWithPreferences({}));
    Object.defineProperty(window.navigator, "language", {
      value: "cs-CZ",
      configurable: true,
    });
    window.localStorage.clear();
    act(() => {
      usePreferencesStore.setState({ unitSystem: "metric", hydrated: false });
    });
  });

  afterEach(() => {
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
});
