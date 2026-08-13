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
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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
    useEntitlementsMock.mockReturnValue({ tier: "free", refetch: vi.fn() });
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

  it("does NOT export on an entitlement lookup ERROR — retries instead (never fails open)", async () => {
    // This GPX is generated locally with no server to enforce the entitlement,
    // so a lookup error must NOT wave the export through. The button stays
    // clickable (so a paid rider isn't stranded), but the click retries + warns
    // rather than exporting or opening a stale upgrade modal.
    const { tripToGpx } = await import("@/lib/trip-export");
    const { toast } = await import("@/lib/toast");
    // These module-level mocks aren't reset per-test; clear prior calls.
    vi.mocked(tripToGpx).mockClear();
    vi.mocked(toast.error).mockClear();
    const refetch = vi.fn();
    useEntitlementsMock.mockReturnValue({ tier: "free", refetch });
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
    expect(vi.mocked(tripToGpx)).not.toHaveBeenCalled(); // no fail-open export
    expect(screen.queryByRole("dialog")).toBeNull(); // no stale upgrade modal
    expect(refetch).toHaveBeenCalled(); // retries the entitlement lookup
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
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
