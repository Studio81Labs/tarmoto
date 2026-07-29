/**
 * #M4 — OfflineRegionsScreen entitlement gating.
 *
 * Two independent gates:
 *   - `offline_maps` (Pro toggle) gates the WHOLE screen: a resolved,
 *     non-entitled rider must see a locked upsell and none of the download
 *     UI (no region list, no "Save current area" entry point). The download
 *     pipeline is owned above the gate so it can be cancelled on a revocation
 *     transition, so a locked mount is inert rather than absent.
 *   - `max_offline_regions` (a numeric cap) is a SEPARATE, later check
 *     inside the entitled content: it blocks a NEW "Save current area"
 *     tap once `regions.length` is at/over the resolved limit, without
 *     disturbing the hook's own `too-many-tiles`/`busy` outcomes.
 *
 * `useOfflineRegions` is mocked at the `@/hooks` barrel (the module the
 * screen actually imports from) so these tests can assert the locked/
 * unresolved rider sees no download UI, drive the revocation-cancel seam,
 * and control `regions` / `saveRegion` directly for the limit-gate cases.
 */
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import OfflineRegionsScreen from "../OfflineRegionsScreen";
import { useAuthStore } from "@/stores";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import { setActiveFormatContext } from "@/format";
import type { OfflineRegion } from "@/services/offlineRegions";

const mockSaveRegion = jest.fn();
const mockRetryRegion = jest.fn();
const mockCancelDownload = jest.fn();
const mockCancelAllDownloads = jest.fn();
const mockDeleteRegion = jest.fn();
let mockRegions: OfflineRegion[] = [];

// The screen owns `useOfflineRegions()` above the entitlement gate so the
// download pipeline survives the locked/unlocked toggle and can be cancelled
// on a revocation transition. `cancelAllDownloads` is the seam the gate calls
// when `offline_maps` flips off mid-download.
const mockUseOfflineRegions = jest.fn(() => ({
  regions: mockRegions,
  activeRegionId: null,
  saveRegion: mockSaveRegion,
  retryRegion: mockRetryRegion,
  cancelDownload: mockCancelDownload,
  cancelAllDownloads: mockCancelAllDownloads,
  deleteRegion: mockDeleteRegion,
}));

jest.mock("@/hooks", () => ({
  useOfflineRegions: () => mockUseOfflineRegions(),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

function makeRegion(overrides: Partial<OfflineRegion> = {}): OfflineRegion {
  return {
    id: overrides.id ?? "region-1",
    name: overrides.name ?? "Area near 49.82, 18.26",
    bbox: overrides.bbox ?? { west: 18, south: 49.7, east: 18.5, north: 49.9 },
    minZoom: overrides.minZoom ?? 8,
    maxZoom: overrides.maxZoom ?? 14,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    status: overrides.status ?? "complete",
    totalTiles: overrides.totalTiles ?? 100,
    downloadedTiles: overrides.downloadedTiles ?? 100,
    failedTiles: overrides.failedTiles ?? 0,
    bytesOnDisk: overrides.bytesOnDisk ?? 1024 * 1024,
    lastError: overrides.lastError ?? null,
    lastUpdatedAt: overrides.lastUpdatedAt ?? 1_700_000_000_000,
  };
}

describe("OfflineRegionsScreen entitlement gating (#M4)", () => {
  beforeEach(() => {
    mockUseOfflineRegions.mockClear();
    mockCancelAllDownloads.mockClear();
    mockSaveRegion.mockReset().mockResolvedValue({ ok: true, regionId: "r1" });
    mockRegions = [];
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  afterEach(() => act(() => useAuthStore.setState({ user: null })));

  describe("offline_maps feature gate", () => {
    it("(a) shows the locked upsell and no download UI when resolved and not entitled", async () => {
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "free",
          features: { offline_maps: false },
          limits: {},
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      expect(screen.getByText("Offline maps are a Pro feature")).toBeTruthy();
      expect(screen.getByText("Offline maps are a Pro feature.")).toBeTruthy();
      expect(screen.getByText("Upgrade required")).toBeTruthy();
      // The gate's user-facing invariant: a Free rider sees none of the
      // download surface — no region list header, no "Save current area".
      expect(screen.queryByText("Offline map regions")).toBeNull();
      expect(
        screen.queryByLabelText("Save current map area for offline use"),
      ).toBeNull();
      // A resolved-locked mount cancels defensively: this also covers the
      // reopen-after-revocation path (started a download, left, lost access
      // elsewhere, reopened locked) — the module-level registry means the
      // lingering job is aborted even though no on-screen transition fired.
      expect(mockCancelAllDownloads).toHaveBeenCalled();
    });

    it("(b) renders the real screen and its download UI when resolved and entitled", async () => {
      mockRegions = [makeRegion()];
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          limits: { max_offline_regions: null },
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      expect(mockUseOfflineRegions).toHaveBeenCalled();
      expect(screen.queryByText("Offline maps are a Pro feature")).toBeNull();
      expect(screen.getByText("Offline map regions")).toBeTruthy();
      expect(screen.getByText("Area near 49.82, 18.26")).toBeTruthy();
      // No spurious cancel on a normal entitled mount.
      expect(mockCancelAllDownloads).not.toHaveBeenCalled();
    });

    it("(c) fails closed while the entitlement snapshot is unresolved — no paid UI, no upsell", async () => {
      // No `features`/`limits` slice at all (e.g. a legacy cached profile,
      // or the pre-first-refresh window) — `isResolved` must be false, not
      // "treat as entitled".
      useAuthStore.setState({
        user: { id: "u1", subscription_tier: "free" } as never,
      });

      await render(<OfflineRegionsScreen />);

      expect(screen.queryByText("Offline map regions")).toBeNull();
      expect(screen.queryByText("Offline maps are a Pro feature")).toBeNull();
      expect(screen.queryByText("Upgrade required")).toBeNull();
      // Unresolved is not a revocation — nothing to cancel.
      expect(mockCancelAllDownloads).not.toHaveBeenCalled();
    });

    it("(g) cancels in-flight downloads when offline_maps is revoked mid-session", async () => {
      // Entitled first: the screen mounts the pipeline and the download UI.
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          limits: { max_offline_regions: null },
        } as never,
      });

      const { rerender } = await render(<OfflineRegionsScreen />);
      expect(screen.getByText("Offline map regions")).toBeTruthy();
      expect(mockCancelAllDownloads).not.toHaveBeenCalled();

      // Access is revoked while the rider is still on the screen (a downgrade
      // or operator force-off lands via an entitlements refresh). The gate
      // must stop the paid download pipeline, not leave it consuming
      // bandwidth/disk for a rider who lost access.
      await act(async () => {
        useAuthStore.setState({
          user: {
            id: "u1",
            subscription_tier: "free",
            features: { offline_maps: false },
            limits: {},
          } as never,
        });
      });
      await rerender(<OfflineRegionsScreen />);

      expect(mockCancelAllDownloads).toHaveBeenCalledTimes(1);
      // And the screen now shows the locked upsell instead of the list.
      expect(screen.getByText("Offline maps are a Pro feature")).toBeTruthy();
    });
  });

  describe("max_offline_regions limit gate", () => {
    it("(d) blocks Save at the resolved cap and shows the prompt instead of saving", async () => {
      mockRegions = [
        makeRegion({ id: "region-1" }),
        makeRegion({ id: "region-2" }),
      ];
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          // An OVERRIDE-clamped cap: `upgradeTierForLimit` returns null (no
          // tier upgrade lifts an operator override), so the prompt shows the
          // NEUTRAL copy + "Limit reached", never "Upgrade for more".
          limits: { max_offline_regions: 2 },
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      await fireEvent.press(
        screen.getByLabelText("Save current map area for offline use"),
      );

      expect(mockSaveRegion).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "You've saved the maximum offline regions for your plan (2 regions).",
        ),
      ).toBeTruthy();
      expect(screen.getByText("Limit reached")).toBeTruthy();
      expect(screen.queryByText(/Upgrade for more\.$/)).toBeNull();
    });

    it("(e) calls saveRegion when under the resolved cap", async () => {
      mockRegions = [makeRegion({ id: "region-1" })];
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          limits: { max_offline_regions: 2 },
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      await fireEvent.press(
        screen.getByLabelText("Save current map area for offline use"),
      );

      expect(mockSaveRegion).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Upgrade for more\.$/)).toBeNull();
    });

    it("cancels in-flight downloads and blocks Save when road_quality_overlay is killed", async () => {
      // Every offline tile is a quality MVT, so the bad-tile-build kill must
      // stop the pipeline — no new downloads of the pulled tiles.
      (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          limits: { max_offline_regions: 2 },
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      // In-flight jobs cancelled on the kill.
      expect(mockCancelAllDownloads).toHaveBeenCalled();

      // Save entry point is disabled and does not start a download.
      const saveBtn = screen.getByLabelText(
        "Save current map area for offline use",
      );
      expect(saveBtn.props.accessibilityState?.disabled).toBe(true);
      await fireEvent.press(saveBtn);
      expect(mockSaveRegion).not.toHaveBeenCalled();
    });

    it("(f) disables Save while the max_offline_regions snapshot is unresolved", async () => {
      // `features` is present (so the outer offline_maps gate resolves
      // entitled and mounts the real screen) but `limits` is absent — the
      // limit gate must fail closed independently of the feature gate.
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
        } as never,
      });

      await render(<OfflineRegionsScreen />);

      const saveBtn = screen.getByLabelText(
        "Save current map area for offline use",
      );
      expect(saveBtn.props.accessibilityState?.disabled).toBe(true);

      await fireEvent.press(saveBtn);

      expect(mockSaveRegion).not.toHaveBeenCalled();
      expect(screen.queryByText("Upgrade required")).toBeNull();
      expect(screen.queryByText("Limit reached")).toBeNull();
    });

    it("dismisses the max_offline_regions upsell when road_quality_overlay is killed", async () => {
      mockRegions = [
        makeRegion({ id: "region-1" }),
        makeRegion({ id: "region-2" }),
      ];
      useAuthStore.setState({
        user: {
          id: "u1",
          subscription_tier: "pro",
          features: { offline_maps: true },
          limits: { max_offline_regions: 2 },
        } as never,
      });

      const { rerender } = await render(<OfflineRegionsScreen />);

      // At cap → Save opens the upsell (overlay still enabled).
      await fireEvent.press(
        screen.getByLabelText("Save current map area for offline use"),
      );
      expect(screen.getByText("Limit reached")).toBeTruthy();

      // Operator kills the overlay while the prompt is open.
      (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
      await act(async () => rerender(<OfflineRegionsScreen />));

      await waitFor(() =>
        expect(screen.queryByText("Limit reached")).toBeNull(),
      );
    });
  });
});
