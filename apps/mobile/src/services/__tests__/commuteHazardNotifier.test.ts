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
import { useAuthStore, useCommuteStore } from "@/stores";

// Mock the api module so getCommuteRoutes / getCommuteStatus are
// controllable per-test. The service imports `api` from `@/services/api`;
// the mock factory below replaces that exact export.
jest.mock("@/services/api", () => ({
  api: {
    getCommuteRoutes: jest.fn(),
    getCommuteStatus: jest.fn(),
  },
}));

jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => true),
}));

// Import AFTER the mock so the service binds to the mocked `api`.
import { AppState } from "react-native";
import { api } from "@/services/api";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";
import {
  __resetCommuteHazardNotifierForTest,
  __setNotifierForTest,
  checkCommuteHazardsAndNotify,
  decideCommuteHazardNotification,
  startCommuteHazardMonitor,
  type Notifier,
  type NotificationPayload,
} from "../commuteHazardNotifier";

const mockApi = api as jest.Mocked<typeof api>;
const mockedKillSwitch = isFeatureKillSwitchActive as jest.MockedFunction<
  typeof isFeatureKillSwitchActive
>;

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "h1",
    lat: 49.8,
    lng: 18.2,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
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
    created_at: "2026-04-20T07:30:00.000Z",
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
    hazard_count: hazards.length,
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
      hazards: [makeHazard({ id: "h1", road_name: null })],
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
    // Reset both the in-memory cache AND the MMKV-backed storage shim.
    // setState alone would leave stale seen-sets readable via the
    // decodeSeen fallback, leaking between tests.
    const { seenHazardsByRoute, clearRoute } = useCommuteStore.getState();
    for (const routeId of Object.keys(seenHazardsByRoute)) clearRoute(routeId);
    useCommuteStore.setState({ seenHazardsByRoute: {} });
    fake = createFakeNotifier();
    __setNotifierForTest(fake);
    mockApi.getCommuteRoutes.mockReset();
    mockApi.getCommuteStatus.mockReset();
    mockedKillSwitch.mockReset();
    mockedKillSwitch.mockReturnValue(true);
    // Entitled by default so the fetch/notify tests exercise the real path.
    // The entitlement-gate test below overrides this.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: { commuter_mode: true },
        limits: {},
      } as never,
    });
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

  it("no-ops when the hazard_alerts operator kill switch is off", async () => {
    // The same free-tier switch that silences map hazard reception also
    // silences this app-level commute alert during an alert-spam storm — even
    // for an otherwise-entitled commuter_mode rider.
    mockedKillSwitch.mockImplementation((key) => key !== "hazard_alerts");
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);

    const result = await checkCommuteHazardsAndNotify();

    expect(result).toEqual({
      notified: false,
      hazardIds: [],
      reason: "hazard-alerts-disabled",
    });
    // Gated before any /commute/* call.
    expect(mockApi.getCommuteRoutes).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("never touches /commute/* for a rider without commuter_mode", async () => {
    // This monitor runs on cold start + every foreground OUTSIDE React, so it
    // reads the entitlement off the auth store rather than a hook. A resolved
    // non-entitled rider must not fire the guarded endpoints and swallow 403s.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { commuter_mode: false },
        limits: {},
      } as never,
    });
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);

    const result = await checkCommuteHazardsAndNotify();

    expect(result).toEqual({
      notified: false,
      hazardIds: [],
      reason: "commute-not-entitled",
    });
    expect(mockApi.getCommuteRoutes).not.toHaveBeenCalled();
    expect(mockApi.getCommuteStatus).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("fails closed (no fetch) when the entitlement snapshot is unresolved", async () => {
    // Legacy cached profile: no `features` slice at all.
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);

    const result = await checkCommuteHazardsAndNotify();

    expect(result.reason).toBe("commute-not-entitled");
    expect(mockApi.getCommuteRoutes).not.toHaveBeenCalled();
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
    expect(fake.calls[0]?.title).toBe("1 new hazard on your commute");
  });

  it("does not deliver the alert if commuter_mode is revoked while the request is in flight", async () => {
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    // The status request was authorized while entitled, but a revoke lands
    // before it resolves — flip the snapshot to disabled as the status returns.
    mockApi.getCommuteStatus.mockImplementation(async () => {
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "free",
          features: { commuter_mode: false },
          limits: {},
        } as never,
      });
      return makeStatus([makeHazard({ id: "h1", road_name: "Elm Ave" })]);
    });

    const result = await checkCommuteHazardsAndNotify();

    // The start gate passed (still entitled), but the recheck BEFORE notify
    // catches the revoke → no paid alert is delivered.
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("commute-not-entitled");
    expect(fake.calls).toHaveLength(0);
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
    expect(fake.calls[1]?.body).toContain("Oak Rd");
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

  it("reports 'all-seen' when current hazards are acknowledged, even if alreadyNotified still holds stale IDs", async () => {
    // First check: alert on h1. Afterward alreadyNotified = {h1}.
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute({ id: "route-1" })]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })]),
    );
    const first = await checkCommuteHazardsAndNotify();
    expect(first.notified).toBe(true);

    // Rider visits CommuteScreen and acknowledges a fresh batch [h2, h3].
    // Current status now reports exactly those two hazards (h1 has expired
    // server-side). The diagnostic reason should be "all-seen" — the batch
    // was filtered by lastSeen, not by the stale alreadyNotified entry.
    useCommuteStore.getState().markHazardsSeen("route-1", ["h2", "h3"]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h2" }), makeHazard({ id: "h3" })]),
    );

    const result = await checkCommuteHazardsAndNotify();
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("all-seen");
  });

  it("short-circuits a concurrent call with reason 'check-in-progress'", async () => {
    // Use a one-shot `Deferred` instead of a shared `resolveRoutes` closure
    // so the second (short-circuiting) call can't silently overwrite the
    // first call's resolver. `mockImplementationOnce` binds the pending
    // promise to just the first invocation; any follow-up call to
    // getCommuteRoutes gets the empty-array value we set below.
    const firstRoutes = createDeferred<CommuteRoute[]>();
    mockApi.getCommuteRoutes
      .mockImplementationOnce(() => firstRoutes.promise)
      .mockResolvedValue([makeRoute()]);
    mockApi.getCommuteStatus.mockResolvedValue(
      makeStatus([makeHazard({ id: "h1" })]),
    );

    const first = checkCommuteHazardsAndNotify();
    // Before `first` resolves its awaited getRoutes, fire a second check.
    const second = await checkCommuteHazardsAndNotify();
    expect(second.notified).toBe(false);
    expect(second.reason).toBe("check-in-progress");

    // Complete the first check — it should still notify normally and
    // release the guard for future calls.
    firstRoutes.resolve([makeRoute()]);
    const firstResult = await first;
    expect(firstResult.notified).toBe(true);
    expect(fake.calls).toHaveLength(1);

    // A subsequent call after `first` finishes runs normally again.
    // Swap the hanging mockImplementation for a resolved one — otherwise
    // the third call would await a never-resolved routes promise and
    // time out instead of returning the expected dedup reason.
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);
    const third = await checkCommuteHazardsAndNotify();
    // h1 was notified on `first`, so this is a dedup hit — not in-progress.
    expect(third.reason).toBe("all-notified");
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Monitor lifecycle ──

describe("startCommuteHazardMonitor", () => {
  beforeEach(() => {
    __resetCommuteHazardNotifierForTest();
    __setNotifierForTest(createFakeNotifier());
    // Reset call history (not just the resolved value) so per-test fetch-count
    // assertions aren't polluted by earlier tests.
    mockApi.getCommuteRoutes.mockReset().mockResolvedValue([]);
    mockApi.getCommuteStatus.mockReset().mockResolvedValue(makeStatus([]));
  });

  afterEach(() => {
    __resetCommuteHazardNotifierForTest();
  });

  it("returned cleanup only removes its own subscription, not a newer one", () => {
    const addSpy = jest.spyOn(AppState, "addEventListener");

    // First start — captures sub1. Fake the subscription `.remove` so we
    // can assert which subscription was torn down.
    const sub1Remove = jest.fn();
    addSpy.mockReturnValueOnce({ remove: sub1Remove });
    const stop1 = startCommuteHazardMonitor();

    // Second start — captures sub2. If it removed sub1 via
    // stopCommuteHazardMonitor() at the top, sub1Remove should fire
    // exactly once here (expected — housekeeping).
    const sub2Remove = jest.fn();
    addSpy.mockReturnValueOnce({ remove: sub2Remove });
    startCommuteHazardMonitor();

    expect(sub1Remove).toHaveBeenCalledTimes(1);
    expect(sub2Remove).not.toHaveBeenCalled();

    // Now invoke the *first* start's cleanup. The pre-fix bug would
    // delegate to `stopCommuteHazardMonitor` and remove sub2 — stopping
    // hazard checks for an unrelated consumer. The fix binds the
    // cleanup to its own sub1, so sub2 must stay live.
    stop1();
    expect(sub2Remove).not.toHaveBeenCalled();

    addSpy.mockRestore();
  });

  it("re-runs the check when commuter_mode resolves after an optimistic cold start", async () => {
    const addSpy = jest
      .spyOn(AppState, "addEventListener")
      .mockReturnValue({ remove: jest.fn() });
    // App.tsx starts the monitor as soon as a cached profile clears loading.
    // Here that cached profile has no `features` slice, so the immediate check
    // fails closed and issues no request.
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);

    const stop = startCommuteHazardMonitor();
    await Promise.resolve();
    expect(mockApi.getCommuteRoutes).not.toHaveBeenCalled();

    // The refreshed snapshot lands with commuter_mode granted — the auth-store
    // watcher must retry the check (AppState never fired for this transition).
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: { commuter_mode: true },
        limits: {},
      } as never,
    });
    await Promise.resolve();

    expect(mockApi.getCommuteRoutes).toHaveBeenCalled();
    stop();
    addSpy.mockRestore();
  });

  it("does not retry on an unrelated profile change while commuter_mode stays off", async () => {
    const addSpy = jest
      .spyOn(AppState, "addEventListener")
      .mockReturnValue({ remove: jest.fn() });
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { commuter_mode: false },
        limits: {},
      } as never,
    });
    mockApi.getCommuteRoutes.mockResolvedValue([makeRoute()]);

    const stop = startCommuteHazardMonitor();
    await Promise.resolve();

    // A display-name edit (still no commuter_mode) must not trigger a fetch.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { commuter_mode: false },
        limits: {},
        display_name: "Renamed",
      } as never,
    });
    await Promise.resolve();

    expect(mockApi.getCommuteRoutes).not.toHaveBeenCalled();
    stop();
    addSpy.mockRestore();
  });
});
