import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
  // UpgradePrompt's Checkout kill-switch gate — live, as in production.
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RideExportMenu } from "./RideExportMenu";

describe("RideExportMenu — gpx_export gate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("exports GPX normally when the feature is enabled", async () => {
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isSuccess: true,
    });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /GPX/i }));
    expect(onExport).toHaveBeenCalledWith("gpx");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the upgrade modal and does NOT export GPX when the feature is off", async () => {
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isSuccess: true,
    });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /GPX/i }));
    expect(onExport).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("keeps CSV export free regardless of the GPX gate", async () => {
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isSuccess: true,
    });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /CSV/i }));
    expect(onExport).toHaveBeenCalledWith("csv");
  });

  it("lets the GPX export proceed on an entitlement lookup ERROR (defers to the backend)", async () => {
    // /users/me failed with no cached snapshot. Blocking would strand even paid
    // riders for the whole outage; the ride GPX export is server-enforced, so
    // let the click through and let the backend 403 a non-entitled rider.
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    const gpxItem = screen.getByRole("menuitem", { name: /GPX/i });
    expect(gpxItem).not.toBeDisabled();
    await userEvent.click(gpxItem);
    // Proceeds to the (server-enforced) export — no dead-end upgrade modal.
    expect(onExport).toHaveBeenCalledWith("gpx");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the GPX item (but not CSV) in the cold-load window", async () => {
    // Pre-auth: the query is disabled → isLoading false, isSuccess false. GPX
    // must still be disabled (an early click can't mis-fire the modal); CSV
    // stays free.
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isSuccess: false,
    });
    useEntitlementsMock.mockReturnValue({ tier: null });
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<RideExportMenu onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    const gpxItem = screen.getByRole("menuitem", { name: /GPX/i });
    expect(gpxItem).toBeDisabled();
    await userEvent.click(gpxItem);
    expect(onExport).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // CSV is unaffected by the gate.
    expect(screen.getByRole("menuitem", { name: /CSV/i })).not.toBeDisabled();
  });
});
