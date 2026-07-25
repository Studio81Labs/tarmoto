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
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isSuccess: true,
    });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("exports normally when gpx_export is enabled", async () => {
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isSuccess: true,
    });
    render(<TripExportButton trip={trip} />);
    await userEvent.click(screen.getByRole("button", { name: /Export GPX/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays ENABLED and exports on an entitlement lookup ERROR (doesn't block paid riders)", async () => {
    // /users/me exhausted its retries with no cached snapshot. Blocking here
    // would strand even paid riders for the whole outage; the cap is unknown, so
    // let the (locally generated) export proceed instead of the upgrade modal.
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    render(<TripExportButton trip={trip} />);
    const button = screen.getByRole("button", { name: /Export GPX/i });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays disabled in the cold-load window (query disabled: isLoading false, isSuccess false)", async () => {
    // Pre-auth: the /users/me query is disabled, so isLoading is false yet the
    // snapshot hasn't resolved. A Pro rider clicking here must NOT set a stale
    // upgrade modal — the button must remain disabled until isSuccess.
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isSuccess: false,
    });
    useEntitlementsMock.mockReturnValue({ tier: null });
    render(<TripExportButton trip={trip} />);
    const button = screen.getByRole("button", { name: /Export GPX/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
