import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useFeatureMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", () => ({
  useFeature: (k: string) => useFeatureMock(k),
  useEntitlements: () => useEntitlementsMock(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// The GPX generator + download side effects — stub so the test asserts gating,
// not file output. Match the real import in TripExportButton.tsx.
vi.mock("@/lib/trip-export", () => ({
  tripToGpx: vi.fn(() => "<gpx/>"),
  tripFileName: vi.fn(() => "trip.gpx"),
}));

import { TripExportButton } from "./TripExportButton";

const trip = { id: "t1", name: "Alps", status: "planned" } as never;

describe("TripExportButton — gpx_export gate", () => {
  beforeEach(() => {
    useFeatureMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
  });

  it("opens the upgrade modal instead of exporting when gpx_export is off", async () => {
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: false });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("exports normally when gpx_export is enabled", async () => {
    useFeatureMock.mockReturnValue({ enabled: true, isLoading: false });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is disabled while entitlements are unresolved (no mis-fired upgrade modal)", async () => {
    // During auth/profile hydration useFeature reports enabled:false + loading;
    // the button must be disabled so a Pro rider's early click doesn't set the
    // upgrade modal that then renders stale once the tier resolves.
    useFeatureMock.mockReturnValue({ enabled: false, isLoading: true });
    useEntitlementsMock.mockReturnValue({ tier: null });
    render(<TripExportButton trip={trip} />);
    const button = screen.getByRole("button", { name: /Export GPX/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
