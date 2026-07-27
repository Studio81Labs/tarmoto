/**
 * #M4 — OfflineRegionsScreen entitlement gating.
 *
 * Two independent gates:
 *   - `offline_maps` (Pro toggle) gates the WHOLE screen: a resolved,
 *     non-entitled rider must see a locked upsell and must never mount
 *     `useOfflineRegions()` (no region list load, no downloader).
 *   - `max_offline_regions` (a numeric cap) is a SEPARATE, later check
 *     inside the entitled content: it blocks a NEW "Save current area"
 *     tap once `regions.length` is at/over the resolved limit, without
 *     disturbing the hook's own `too-many-tiles`/`busy` outcomes.
 *
 * `useOfflineRegions` is mocked at the `@/hooks` barrel (the module the
 * screen actually imports from) so these tests can assert the hook never
 * mounts for a locked/unresolved rider, and can control `regions` /
 * `saveRegion` directly for the limit-gate cases.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import OfflineRegionsScreen from "../OfflineRegionsScreen";
import { useAuthStore } from "@/stores";
import { setActiveFormatContext } from "@/format";
import type { OfflineRegion } from "@/services/offlineRegions";

const mockSaveRegion = jest.fn();
const mockRetryRegion = jest.fn();
const mockCancelDownload = jest.fn();
const mockDeleteRegion = jest.fn();
let mockRegions: OfflineRegion[] = [];

// Wrapped in a jest.fn spy (rather than a bare arrow) so the #M4 gating
// tests can assert `useOfflineRegions` never mounts — and therefore the
// region list never loads and no download ever fires — for a resolved-
// non-entitled or unresolved rider.
const mockUseOfflineRegions = jest.fn(() => ({
  regions: mockRegions,
  activeRegionId: null,
  saveRegion: mockSaveRegion,
  retryRegion: mockRetryRegion,
  cancelDownload: mockCancelDownload,
  deleteRegion: mockDeleteRegion,
}));

jest.mock("@/hooks", () => ({
  useOfflineRegions: () => mockUseOfflineRegions(),
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
    mockSaveRegion.mockReset().mockResolvedValue({ ok: true, regionId: "r1" });
    mockRegions = [];
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  afterEach(() => act(() => useAuthStore.setState({ user: null })));

  describe("offline_maps feature gate", () => {
    it("(a) shows the locked upsell and never mounts useOfflineRegions when resolved and not entitled", async () => {
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
      // The whole point of the gate: a Free rider must never mount the
      // region list / downloader hook.
      expect(mockUseOfflineRegions).not.toHaveBeenCalled();
    });

    it("(b) renders the real screen and mounts useOfflineRegions when resolved and entitled", async () => {
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

      expect(mockUseOfflineRegions).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Offline maps are a Pro feature")).toBeNull();
      expect(screen.getByText("Offline map regions")).toBeTruthy();
      expect(screen.getByText("Area near 49.82, 18.26")).toBeTruthy();
    });

    it("(c) fails closed while the entitlement snapshot is unresolved — no paid UI, no upsell, no hook mount", async () => {
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
      expect(mockUseOfflineRegions).not.toHaveBeenCalled();
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
  });
});
