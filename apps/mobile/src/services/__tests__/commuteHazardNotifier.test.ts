/**
 * Commute hazard notifier tests — US-15 AC #2.
 *
 * Coverage split:
 *   - `decideCommuteHazardNotification` is pure → exhaustive branch tests
 *     with no mocks.
 *   - `checkCommuteHazardsAndNotify` is the glue between api + store +
 *     notifier → asserted with an injected fake notifier and a mocked
 *     api client, so we never hit a real backend or the RN Alert surface.
 */

import type { Hazard, CommuteRoute, CommuteStatus } from "@/types";
import { useCommuteStore } from "@/stores";

// Mock the api module so getCommuteRoutes / getCommuteStatus are
// controllable per-test. The service imports `api` from `@/services/api`;
// the mock factory below replaces that exact export.
jest.mock("@/services/api", () => ({
  api: {
    getCommuteRoutes: jest.fn(),
    getCommuteStatus: jest.fn(),
  },
}));

// Import AFTER the mock so the service binds to the mocked `api`.
/* eslint-disable import/first */
import { api } from "@/services/api";
import {
  __resetCommuteHazardNotifierForTest,
  __setNotifierForTest,
  checkCommuteHazardsAndNotify,
  decideCommuteHazardNotification,
  type Notifier,
  type NotificationPayload,
} from "../commuteHazardNotifier";
/* eslint-enable import/first */

const mockApi = api as jest.Mocked<typeof api>;

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "h1",
    lat: 49.8,
    lng: 18.2,
    hazard_type: "pothole",
    severity: "medium",
    confirmations: 0,
    reporter: "user-1",
    road_name: "Main St",
    created_at: "2026-04-19T08:00:00Z",
    expires_at: "2026-04-20T08:00:00Z",
    ...overrides,
  };
}

function makeRoute(overrides: Partial<CommuteRoute> = {}): CommuteRoute {
  return {
    id: "route-1",
    name: "Home → Work",
    origin: { lat: 49.8, lng: 18.2 },
    destination: { lat: 49.9, lng: 18.3 },
    distance_km: 12.5,
    avg_duration_min: 22,
    avg_quality: 3.5,
    is_primary: true,
    route_geometry: [],
    ...overrides,
  };
}

function makeStatus(
  hazards: Hazard[],
  overrides: Partial<CommuteStatus> = {},
): CommuteStatus {
  return {
    route: makeRoute(),
    hazards,
    weather: {
      temperature_c: 15,
      condition: "clear",
      wind_kmh: 5,
      precipitation_chance: 0,
      road_condition: "dry",
      description: "Clear skies",
    },
    estimated_time_min: 22,
    route_quality: 3.5,
    status: "hazards",
    ...overrides,
  };
}

function createFakeNotifier(available = true): Notifier & {
  calls: NotificationPayload[];
} {
  const calls: NotificationPayload[] = [];
  return {
    calls,
    isAvailable: () => available,
    notify: (p) => {
      calls.push(p);
    },
  };
}

// ── Pure decision logic ──

describe("decideCommuteHazardNotification", () => {
  it("returns null when there are no hazards", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    expect(out).toBeNull();
  });

  it("returns null when every hazard has been seen on CommuteScreen", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [makeHazard({ id: "h1" }), makeHazard({ id: "h2" })],
      lastSeen: new Set(["h1", "h2"]),
      alreadyNotified: new Set(),
    });
    expect(out).toBeNull();
  });

  it("returns null when every new hazard was already notified this session", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [makeHazard({ id: "h1" })],
      lastSeen: new Set(),
      alreadyNotified: new Set(["h1"]),
    });
    expect(out).toBeNull();
  });

  it("produces a single-hazard payload naming the road", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [makeHazard({ id: "h1", road_name: "Elm Ave" })],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    expect(out).not.toBeNull();
    expect(out?.title).toBe("1 new hazard on your commute");
    expect(out?.body).toContain("Elm Ave");
    expect(out?.hazardIds).toEqual(["h1"]);
  });

  it("produces a multi-hazard payload with pluralised copy", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [
        makeHazard({ id: "h1", road_name: "Elm Ave" }),
        makeHazard({ id: "h2", road_name: "Oak Rd" }),
        makeHazard({ id: "h3", road_name: "Pine St" }),
      ],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    expect(out?.title).toBe("3 new hazards on your commute");
    expect(out?.body).toContain("Elm Ave");
    expect(out?.body).toContain("2 other spots");
    expect(out?.hazardIds).toEqual(["h1", "h2", "h3"]);
  });

  it("only surfaces hazards that are unseen AND un-notified", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [
        makeHazard({ id: "seen" }),
        makeHazard({ id: "already-notified" }),
        makeHazard({ id: "fresh", road_name: "Oak Rd" }),
      ],
      lastSeen: new Set(["seen"]),
      alreadyNotified: new Set(["already-notified"]),
    });
    expect(out?.hazardIds).toEqual(["fresh"]);
    expect(out?.body).toContain("Oak Rd");
  });

  it("falls back to route name when hazard has no road_name", () => {
    const out = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "Home → Work",
      hazards: [makeHazard({ id: "h1", road_name: undefined })],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    expect(out?.body).toContain("Home → Work");
  });

  it("tag is stable for identical input sets regardless of order", () => {
    const a = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "R",
      hazards: [makeHazard({ id: "b" }), makeHazard({ id: "a" })],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    const b = decideCommuteHazardNotification({
      routeId: "r1",
      routeName: "R",
      hazards: [makeHazard({ id: "a" }), makeHazard({ id: "b" })],
      lastSeen: new Set(),
      alreadyNotified: new Set(),
    });
    expect(a?.tag).toBe(b?.tag);
  });
});

// ── End-to-end flow ──

describe("checkCommuteHazardsAndNotify", () => {
  let fake: ReturnType<typeof createFakeNotifier>;

  beforeEach(() => {
    __resetCommuteHazardNotifierForTest();
    useCommuteStore.setState({ seenHazardsByRoute: {} });
    fake = createFakeNotifier();
    __setNotifierForTest(fake);
    mockApi.getCommuteRoutes.mockReset();
    mockApi.getCommuteStatus.mockReset();
  });

  it("no-ops when rider has no primary commute yet", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([]);
    const result = await checkCommuteHazardsAndNotify();
    expect(result).toEqual({
      notified: false,
      hazardIds: [],
      reason: "no-primary-commute",
    });
    expect(fake.calls).toHaveLength(0);
    expect(mockApi.getCommuteStatus).not.toHaveBeenCalled();
  });

  it("no-ops when the commute has zero active hazards", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(makeStatus([]));
    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("no-hazards");
    expect(fake.calls).toHaveLength(0);
  });

  it("fires on the first call when new hazards exist", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1", road_name: "Elm Ave" })]),
    );

    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(true);
    expect(result.hazardIds).toEqual(["h1"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].title).toBe("1 new hazard on your commute");
  });

  it("dedups within a session — second call does not re-fire", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })]),
    );

    const first = await checkCommuteHazardsAndNotify();
    const second = await checkCommuteHazardsAndNotify();

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(second.reason).toBe("all-notified");
    expect(fake.calls).toHaveLength(1);
  });

  it("re-fires for a brand new hazard on top of an already-notified one", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })]),
    );
    await checkCommuteHazardsAndNotify(); // notifies h1

    // Backend reports h1 (still active) + h2 (fresh)
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([
        makeHazard({ id: "h1" }),
        makeHazard({ id: "h2", road_name: "Oak Rd" }),
      ]),
    );

    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(true);
    // h1 was already notified; only h2 is fresh.
    expect(result.hazardIds).toEqual(["h2"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].body).toContain("Oak Rd");
  });

  it("respects the rider's seen-set from the commute store", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute({ id: "route-1" })]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" }), makeHazard({ id: "h2" })]),
    );

    // Rider has already acknowledged h1 and h2 on CommuteScreen.
    useCommuteStore.getState().markHazardsSeen("route-1", ["h1", "h2"]);

    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("all-seen");
    expect(fake.calls).toHaveLength(0);
  });

  it("prefers is_primary over the first route when multiple exist", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([
      makeRoute({ id: "secondary", is_primary: false }),
      makeRoute({ id: "primary", is_primary: true }),
    ]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })], {
        route: makeRoute({ id: "primary", is_primary: true }),
      }),
    );

    // Mark h1 seen only on the *secondary* route. Since we should pick
    // the primary, the notification must still fire.
    useCommuteStore.getState().markHazardsSeen("secondary", ["h1"]);

    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("stays silent on network error", async () => {
    mockApi.getCommuteRoutes.mockRejectedValue(new Error("Network Error"));
    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("api-error");
    expect(fake.calls).toHaveLength(0);
  });

  it("stays silent when the notifier reports unavailable", async () => {
    __setNotifierForTest(createFakeNotifier(false));
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })]),
    );
    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("notifier-unavailable");
    // getCommuteStatus should NOT have been called — availability gate
    // short-circuits before any network traffic.
    expect(mockApi.getCommuteStatus).not.toHaveBeenCalled();
  });
});
