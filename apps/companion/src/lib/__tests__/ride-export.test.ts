import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { downloadAllRidesExport, downloadRideExport } from "../ride-export";

vi.mock("@/lib/api", () => ({ api: { GET: vi.fn() } }));
const get = vi.mocked(api.GET);

// An openapi-fetch blob result. The client attaches the bearer + handles 401
// itself, so these tests only cover the export helper's own behaviour.
function blobResult(status = 200) {
  const ok = status >= 200 && status < 300;
  return {
    data: ok ? new Blob(["body"], { type: "text/csv" }) : undefined,
    error: ok ? undefined : {},
    response: new Response(null, { status }),
  } as unknown as Awaited<ReturnType<typeof api.GET>>;
}

describe("ride-export", () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let lastAnchor: HTMLAnchorElement | null;
  const origCreateObjectURL = globalThis.URL.createObjectURL;
  const origRevokeObjectURL = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    get.mockReset().mockResolvedValue(blobResult());
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
    globalThis.URL.createObjectURL = origCreateObjectURL;
    globalThis.URL.revokeObjectURL = origRevokeObjectURL;
  });

  describe("downloadRideExport", () => {
    it("requests the per-ride CSV blob and triggers the download", async () => {
      await downloadRideExport("ride-1", "csv");

      expect(get).toHaveBeenCalledWith("/api/v1/rides/{rideId}/csv", {
        params: { path: { rideId: "ride-1" } },
        parseAs: "blob",
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    });

    it("uses the gpx endpoint when requested", async () => {
      await downloadRideExport("ride-2", "gpx");

      expect(get).toHaveBeenCalledWith("/api/v1/rides/{rideId}/gpx", {
        params: { path: { rideId: "ride-2" } },
        parseAs: "blob",
      });
    });

    it("throws with the HTTP status when the request fails", async () => {
      get.mockResolvedValueOnce(blobResult(403));

      await expect(downloadRideExport("ride-1", "csv")).rejects.toThrow(/403/);
    });
  });

  describe("downloadAllRidesExport", () => {
    it("builds a date-stamped CSV filename and hits /rides/export.csv", async () => {
      await downloadAllRidesExport("csv", new Date("2026-04-20T10:00:00Z"));

      expect(get).toHaveBeenCalledWith("/api/v1/rides/export.csv", {
        parseAs: "blob",
      });
      expect(lastAnchor?.download).toBe("tarmoto-rides-2026-04-20.csv");
    });

    it("uses the gpx extension for gpx format", async () => {
      await downloadAllRidesExport("gpx", new Date("2026-01-02T00:00:00Z"));

      expect(get).toHaveBeenCalledWith("/api/v1/rides/export.gpx", {
        parseAs: "blob",
      });
    });
  });
});
