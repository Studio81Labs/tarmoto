import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { FormatPrefsSync } from "./FormatPrefsSync";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

// jsdom resolves the environment timezone; read it the same way the
// component does so assertions hold regardless of the host TZ.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function clearCookies() {
  for (const cookie of document.cookie.split("; ")) {
    const name = cookie.split("=")[0];
    if (name) {
      document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

describe("FormatPrefsSync", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    Object.defineProperty(window.navigator, "language", {
      value: "cs-CZ",
      configurable: true,
    });
    clearCookies();
    refresh.mockReset();
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs detected prefs and refreshes when cookies are missing", async () => {
    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/format-prefs");
    expect(JSON.parse(String(init.body))).toEqual({
      format_locale: "cs-CZ",
      timezone: DEVICE_TZ,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("no-ops when cookies already match the device", async () => {
    document.cookie = `tarmoto-format-locale=cs-CZ; path=/`;
    document.cookie = `tarmoto-timezone=${DEVICE_TZ}; path=/`;

    render(<FormatPrefsSync />);

    // Give the effect a tick to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("POSTs when the device timezone diverges from the cookie", async () => {
    document.cookie = `tarmoto-format-locale=cs-CZ; path=/`;
    document.cookie = `tarmoto-timezone=Pacific/Auckland; path=/`;

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not refresh when the POST fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
  });
});
