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

import { api } from "../api";
import { __setStorageForTest, enqueueHazardReport } from "../hazardQueue";
import type { Hazard } from "@/types";

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

  it("submits the report without a photo when the upload fails", async () => {
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
