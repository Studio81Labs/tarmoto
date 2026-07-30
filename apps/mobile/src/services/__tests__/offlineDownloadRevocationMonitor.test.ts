/**
 * offlineDownloadRevocationMonitor — app-level offline_maps revocation guard.
 *
 * Cancels in-flight offline downloads on the granted→not-granted transition,
 * regardless of which screen is mounted, so a revoke landing while the rider is
 * off the offline screen still stops the module-level download loop.
 */

import { startOfflineDownloadRevocationMonitor } from "../offlineDownloadRevocationMonitor";
import { useAuthStore } from "@/stores";
import { cancelAllOfflineDownloads } from "@/hooks/useOfflineRegions";

jest.mock("@/hooks/useOfflineRegions", () => ({
  cancelAllOfflineDownloads: jest.fn(),
}));

// Controllable systemSwitchCache: `killed` toggles the road_quality_overlay
// state, and calling `listener()` simulates a /config/flags change notify.
const mockKill = { killed: false, listener: (() => {}) as () => void };
jest.mock("@/services/systemSwitchCache", () => ({
  isFeatureKillSwitchActive: jest.fn(() => !mockKill.killed),
  subscribeSystemSwitchStates: (cb: () => void) => {
    mockKill.listener = cb;
    return () => {
      mockKill.listener = () => {};
    };
  },
}));

const cancelMock = cancelAllOfflineDownloads as jest.MockedFunction<
  typeof cancelAllOfflineDownloads
>;

function entitledUser() {
  return {
    id: "u1",
    subscription_tier: "pro",
    features: { offline_maps: true },
    limits: {},
  } as never;
}

function revokedUser() {
  return {
    id: "u1",
    subscription_tier: "free",
    features: { offline_maps: false },
    limits: {},
  } as never;
}

describe("offlineDownloadRevocationMonitor", () => {
  let unsub: () => void = () => {};

  beforeEach(() => {
    cancelMock.mockClear();
    mockKill.killed = false;
    useAuthStore.setState({ user: entitledUser() });
    unsub = startOfflineDownloadRevocationMonitor();
  });

  afterEach(() => {
    unsub();
    useAuthStore.setState({ user: null });
  });

  it("cancels downloads when offline_maps is revoked while off-screen", () => {
    useAuthStore.setState({ user: revokedUser() });
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("cancels downloads when the rider signs out (null user)", () => {
    useAuthStore.setState({ user: null });
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("does not cancel while the rider stays entitled (a profile re-publish)", () => {
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "premium",
        features: { offline_maps: true },
        limits: {},
      } as never,
    });
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("does not cancel for an already-locked rider (no prior grant)", () => {
    useAuthStore.setState({ user: revokedUser() }); // granted → revoked (cancels)
    cancelMock.mockClear();
    // A further change while already locked must not re-cancel.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { offline_maps: false },
        limits: { max_offline_regions: 0 },
      } as never,
    });
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("stops observing after unsubscribe", () => {
    unsub();
    useAuthStore.setState({ user: revokedUser() });
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("cancels downloads when road_quality_overlay is killed while off-screen", () => {
    // Every offline tile is a quality MVT — a bad-tile-build kill must stop the
    // pipeline even after the rider left the offline screen.
    mockKill.killed = true;
    mockKill.listener(); // /config/flags change notification
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("does not cancel while road_quality_overlay stays enabled", () => {
    mockKill.listener(); // a notify with no state change (still on)
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("stops observing the quality switch after unsubscribe", () => {
    unsub();
    mockKill.killed = true;
    mockKill.listener();
    expect(cancelMock).not.toHaveBeenCalled();
  });
});
