/**
 * Tests the upload-then-submit pairing in `api.submitHazardReport` /
 * `api.flushPendingHazardReports` (US-4 photo upload, issue #344).
 *
 * The api facade routes a `HazardReportPayload` through the offline
 * queue, and on each upload attempt invokes the internal
 * `reportHazardWithPhoto` helper. That helper:
 *   - uploads the photo first (when `photoUri` is set), then
 *   - submits the hazard with the returned `photo_url`.
 *
 * If the upload itself fails, the report is still submitted without
 * a photo — losing the photo is much better than dropping a hazard
 * report the rider already tapped Submit on.
 */

// react-native-mmkv + a few other RN native modules load their
// turbomodule bridge at module-eval time. typedClient (and the
// pushRegistration import chain) trip those bridges when the api
// module is imported here. Stub the offending surfaces so the test
// can exercise the upload-then-submit pairing without spinning up a
// real React Native runtime.
jest.mock("react-native-mmkv", () => {
  const stores = new Map<string, Map<string, unknown>>();
  return {
    createMMKV: ({ id }: { id: string }) => {
      let store = stores.get(id);
      if (!store) {
        store = new Map();
        stores.set(id, store);
      }
      return {
        getString: (k: string) => store!.get(k) as string | undefined,
        set: (k: string, v: unknown) => {
          store!.set(k, v);
        },
        remove: (k: string) => {
          store!.delete(k);
        },
        getAllKeys: () => Array.from(store!.keys()),
      };
    },
  };
});

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { api, ApiError } from "../api";
import { __setStorageForTest, enqueueHazardReport } from "../hazardQueue";
import type { Hazard } from "@/types";
import { HAZARD_PHOTO_EXPIRED } from "@tarmoto/shared";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
  };
}

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "hazard-1",
    lat: 49.82,
    lng: 18.26,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: "rider-1",
    road_name: null,
    created_at: "2026-04-25T08:00:00.000Z",
    expires_at: "2026-04-26T08:00:00.000Z",
    ...overrides,
  };
}

describe("api hazard photo flow", () => {
  let uploadSpy: jest.SpyInstance;
  let reportSpy: jest.SpyInstance;

  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
    uploadSpy = jest.spyOn(api, "uploadHazardPhoto").mockResolvedValue({
      photo_url:
        "https://app.tarmoto.test/uploads/hazard-photos/user-1-1700000000000-abc.jpg",
    });
    reportSpy = jest
      .spyOn(api, "reportHazard")
      .mockImplementation(
        async (lat, lng, hazard_type, severity, note, photoUrl) =>
          makeHazard({
            lat,
            lng,
            hazard_type,
            ...(severity !== undefined ? { severity } : {}),
            note: note ?? null,
            photo_url: photoUrl ?? null,
          }),
      );
  });

  afterEach(() => {
    uploadSpy.mockRestore();
    reportSpy.mockRestore();
  });

  it("uploads the photo first then submits the report with photo_url", async () => {
    const result = await api.submitHazardReport({
      lat: 49.82,
      lng: 18.26,
      hazardType: "pothole",
      severity: "medium",
      note: "deep one",
      photoUri: "file:///tmp/photo.jpg",
    });

    expect(result.status).toBe("uploaded");
    expect(uploadSpy).toHaveBeenCalledWith({ uri: "file:///tmp/photo.jpg" });
    expect(reportSpy).toHaveBeenCalledWith(
      49.82,
      18.26,
      "pothole",
      "medium",
      "deep one",
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-1700000000000-abc.jpg",
    );
    expect(result.hazard?.photo_url).toBe(
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-1700000000000-abc.jpg",
    );
  });

  it("submits the report without a photo when the upload PERMANENTLY fails", async () => {
    // A non-retriable upload rejection (a bad/oversized file the backend will
    // never accept) — losing the photo beats stranding the hazard forever.
    uploadSpy.mockRejectedValueOnce(new Error("upload boom"));

    const result = await api.submitHazardReport({
      lat: 49.82,
      lng: 18.26,
      hazardType: "pothole",
      severity: "medium",
      photoUri: "file:///tmp/photo.jpg",
    });

    expect(result.status).toBe("uploaded");
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(
      49.82,
      18.26,
      "pothole",
      "medium",
      undefined,
      undefined,
    );
  });

  it.each([
    ["the 429 pending-upload quota", new ApiError("quota", 429, {})],
    ["a network failure", new TypeError("Network request failed")],
    [
      "the hazard_reporting kill switch (global 403)",
      new ApiError("killed", 403, {
        feature: "hazard_reporting",
        scope: "global",
      }),
    ],
  ])(
    "does NOT silently drop the photo on %s — rethrows so the report re-queues",
    async (_label, uploadError) => {
      // Codex P2: a transient/quota upload failure — or the operator kill
      // switch (reporting paused, not the file rejected) — clears with time, so
      // the photo-less fallback must NOT fire. The report keeps its photoUri and
      // retries the whole flow later instead of committing without the photo
      // (which would strand the local capture if force_off lifts mid-flow).
      uploadSpy.mockRejectedValueOnce(uploadError);

      await expect(
        (
          api as unknown as {
            reportHazardWithPhoto: (p: {
              lat: number;
              lng: number;
              hazardType: string;
              severity: string;
              photoUri: string;
            }) => Promise<Hazard>;
          }
        ).reportHazardWithPhoto({
          lat: 49.82,
          lng: 18.26,
          hazardType: "pothole",
          severity: "medium",
          photoUri: "file:///tmp/photo.jpg",
        }),
      ).rejects.toBe(uploadError);
      // The report was NOT committed photo-less.
      expect(reportSpy).not.toHaveBeenCalled();
    },
  );

  it("skips the upload step when no photoUri is set", async () => {
    const result = await api.submitHazardReport({
      lat: 49.82,
      lng: 18.26,
      hazardType: "gravel",
      severity: "low",
    });

    expect(result.status).toBe("uploaded");
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(reportSpy).toHaveBeenCalledWith(
      49.82,
      18.26,
      "gravel",
      "low",
      undefined,
      undefined,
    );
  });

  it("re-uploads from photoUri and resubmits when the report hits HAZARD_PHOTO_EXPIRED", async () => {
    // The backend reclaimed the first upload (report sat queued past the 24h
    // grace window) and rejects with HAZARD_PHOTO_EXPIRED. The uploader must
    // re-upload from the retained local URI and resubmit with the FRESH url —
    // NOT silently drop the photo.
    uploadSpy
      .mockResolvedValueOnce({
        photo_url:
          "https://app.tarmoto.test/uploads/hazard-photos/user-1-stale.jpg",
      })
      .mockResolvedValueOnce({
        photo_url:
          "https://app.tarmoto.test/uploads/hazard-photos/user-1-fresh.jpg",
      });
    reportSpy.mockRejectedValueOnce(
      new ApiError("expired", 409, { code: HAZARD_PHOTO_EXPIRED }),
    );

    const result = await api.submitHazardReport({
      lat: 49.82,
      lng: 18.26,
      hazardType: "pothole",
      severity: "medium",
      photoUri: "file:///tmp/photo.jpg",
    });

    expect(result.status).toBe("uploaded");
    // Initial upload + one re-upload from the same retained URI.
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(uploadSpy).toHaveBeenNthCalledWith(2, {
      uri: "file:///tmp/photo.jpg",
    });
    // Resubmitted with the fresh URL, not the stale one.
    expect(reportSpy).toHaveBeenLastCalledWith(
      49.82,
      18.26,
      "pothole",
      "medium",
      undefined,
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-fresh.jpg",
    );
    expect(result.hazard?.photo_url).toBe(
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-fresh.jpg",
    );
  });

  it("does not re-upload on HAZARD_PHOTO_EXPIRED when there is no photoUri", async () => {
    // A report already carrying a resolved photoUrl but no local source URI
    // can't be recovered — the expired error must propagate rather than loop.
    reportSpy.mockRejectedValue(
      new ApiError("expired", 409, { code: HAZARD_PHOTO_EXPIRED }),
    );

    // Directly exercise the uploader with a payload that has photoUrl but no
    // photoUri (no local source to re-upload from).
    await expect(
      (
        api as unknown as {
          reportHazardWithPhoto: (p: {
            lat: number;
            lng: number;
            hazardType: string;
            severity: string;
            photoUrl: string;
          }) => Promise<Hazard>;
        }
      ).reportHazardWithPhoto({
        lat: 49.82,
        lng: 18.26,
        hazardType: "pothole",
        severity: "medium",
        photoUrl:
          "https://app.tarmoto.test/uploads/hazard-photos/user-1-gone.jpg",
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("uploads queued photos when flushing pending reports", async () => {
    // Seed the queue as if a previous offline submit had stashed it.
    enqueueHazardReport({
      lat: 49.82,
      lng: 18.26,
      hazardType: "pothole",
      severity: "high",
      photoUri: "file:///tmp/queued.jpg",
    });

    const drain = await api.flushPendingHazardReports();

    expect(drain.flushed).toBe(1);
    expect(uploadSpy).toHaveBeenCalledWith({ uri: "file:///tmp/queued.jpg" });
    expect(reportSpy).toHaveBeenCalledWith(
      49.82,
      18.26,
      "pothole",
      "high",
      undefined,
      "https://app.tarmoto.test/uploads/hazard-photos/user-1-1700000000000-abc.jpg",
    );
  });
});
