import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { downloadAllRidesExport, downloadRideExport } from "../ride-export";

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

describe("ride-export", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.fn>;
  let lastAnchor: HTMLAnchorElement | null;

  beforeEach(() => {
    useAuthStore.getState().setSession(
      {
        id: "u-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      "test-token",
    );

    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["body"], { type: "text/csv" }),
    })) as unknown as ReturnType<typeof vi.fn>;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
    globalThis.URL.revokeObjectURL = vi.fn();

    lastAnchor = null;
    clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === "a") {
        lastAnchor = el as HTMLAnchorElement;
        (el as HTMLAnchorElement).click =
          clickSpy as unknown as HTMLAnchorElement["click"];
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    useAuthStore.getState().clearSession();
  });

  describe("downloadRideExport", () => {
    it("hits the per-ride CSV endpoint with a bearer token", async () => {
      await downloadRideExport("ride-1", "csv");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/rides/ride-1/csv");
      expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    });

    it("uses the gpx path when requested", async () => {
      await downloadRideExport("ride-2", "gpx");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/rides/ride-2/gpx");
    });

    it("throws with the HTTP status when the request fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as unknown as Response);

      await expect(downloadRideExport("ride-1", "csv")).rejects.toThrow(/403/);
    });

    it("omits the Authorization header when no session token is set", async () => {
      useAuthStore.getState().clearSession();

      await downloadRideExport("ride-1", "csv");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toBeUndefined();
    });
  });

  describe("downloadAllRidesExport", () => {
    it("builds a date-stamped CSV filename and hits /rides/export.csv", async () => {
      await downloadAllRidesExport("csv", new Date("2026-04-20T10:00:00Z"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/rides/export.csv");
      expect(lastAnchor?.download).toBe("tarmoto-rides-2026-04-20.csv");
    });

    it("uses the gpx extension for gpx format", async () => {
      await downloadAllRidesExport("gpx", new Date("2026-01-02T00:00:00Z"));

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/rides/export.gpx");
    });
  });
});
