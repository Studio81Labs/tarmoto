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
    vi.useRealTimers();
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

  it("re-detects preferences when the browser window regains focus", async () => {
    document.cookie = `tarmoto-format-locale=cs-CZ; path=/`;
    document.cookie = `tarmoto-timezone=${DEVICE_TZ}; path=/`;
    render(<FormatPrefsSync />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(window.navigator, "language", {
      value: "de-DE",
      configurable: true,
    });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format_locale: "de-DE",
      timezone: DEVICE_TZ,
    });
  });

  it("retries a transient failure without requiring a remount", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(<FormatPrefsSync />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    errorSpy.mockRestore();
  });

  it("does not refresh when the POST fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to sync format preferences",
      400,
    );
    errorSpy.mockRestore();
  });

  it("logs and does not refresh when the POST rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(<FormatPrefsSync />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to sync format preferences",
      expect.any(Error),
    );
    expect(refresh).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
