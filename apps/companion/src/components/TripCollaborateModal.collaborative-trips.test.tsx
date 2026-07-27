import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import { ApiError } from "@/lib/api";
import type { Trip } from "@/lib/types";

// US-C2: gate the persisted-trip invite-link share on `collaborative_trips`
// (Pro toggle). SP1 enforces this on the backend ONLY when
// `TripSharesService.create` receives a `trip_id` (a share attached to a
// SAVED trip) — a snapshot-only preview share for an unsaved trip
// (`trip_id: null`) stays open to every tier, so the companion gate must
// key on `serverTripId` the same way and never block that free path.

const minimalTrip: Trip = {
  id: "trip-1",
  name: "Pyrenees Loop",
  status: "planned",
  num_days: 0,
  parameters: {
    days: 1,
    dailyKmTarget: 150,
    roadPreference: "curvy",
    surfacePreference: ["asphalt"],
    avoidHighways: true,
    avoidTolls: false,
    avoidUnpaved: true,
    minQuality: 3,
  },
  collaborators: [],
  days: [],
  createdAt: "2026-04-20T10:00:00.000Z",
  updatedAt: "2026-04-20T10:00:00.000Z",
};

const hoisted = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
  listMine: vi.fn(),
  listMembers: vi.fn(),
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripSharesApi: {
      ...actual.tripSharesApi,
      create: hoisted.create,
      revoke: hoisted.revoke,
      listMine: hoisted.listMine,
    },
    // A persisted `serverTripId` triggers the roster fetch (for the People
    // tab's badge count) as a mount effect regardless of which tab is
    // active — stub it so it doesn't surface an unrelated network-error
    // alert in tests that only exercise the Invite tab.
    tripCollabApi: {
      ...actual.tripCollabApi,
      listMembers: hoisted.listMembers,
    },
  };
});

const useFeatureMock = vi.fn(() => ({
  enabled: true,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
const useEntitlementsMock = vi.fn(() => ({ tier: "free" as string | null }));
vi.mock("@/hooks", () => ({
  useFeature: () => useFeatureMock(),
  useEntitlements: () => useEntitlementsMock(),
}));

// UpgradePrompt calls useRouter() for its CTA — the test tree has no app
// router mounted.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const share = (overrides: Partial<{ trip_id: string | null }> = {}) => ({
  id: "share-1",
  share_token: "a".repeat(32),
  share_url: `/trips/shared/${"a".repeat(32)}`,
  trip_id: null,
  title: "Pyrenees Loop",
  view_count: 0,
  created_at: "2026-04-20T10:00:00.000Z",
  updated_at: "2026-04-20T10:00:00.000Z",
  ...overrides,
});

describe("TripCollaborateModal — collaborative_trips gate (US-C2)", () => {
  beforeEach(() => {
    hoisted.create.mockReset();
    hoisted.revoke.mockReset();
    hoisted.listMine
      .mockReset()
      .mockResolvedValue({ data: { items: [], total: 0 } });
    hoisted.listMembers
      .mockReset()
      .mockResolvedValue({ data: { members: [], invites: [] } });
    useFeatureMock.mockReset().mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReset().mockReturnValue({ tier: "free" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(a) generates a persisted-trip share link normally when entitled", async () => {
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.create.mockResolvedValueOnce({
      data: share({ trip_id: "server-trip-1" }),
    });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    const toggle = screen.getByRole("switch", { name: /group link/i });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(hoisted.create).toHaveBeenCalledWith(
        expect.objectContaining({ trip_id: "server-trip-1" }),
      );
    });
    expect(
      screen.queryByText(/sharing an invite link for a saved trip needs pro/i),
    ).not.toBeInTheDocument();
  });

  it("(b) gates the persisted-trip toggle when not entitled — disabled, upsell shown, create not fired", async () => {
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    const toggle = screen.getByRole("switch", { name: /group link/i });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/sharing an invite link for a saved trip needs pro/i),
    ).toBeInTheDocument();

    fireEvent.click(toggle);
    // A disabled native control never dispatches the click to onChange.
    expect(hoisted.create).not.toHaveBeenCalled();
  });

  it("(c) fails closed while the entitlement lookup is unresolved — disabled, no upsell flash", async () => {
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: true,
      isError: false,
      isSuccess: false,
    });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    const toggle = screen.getByRole("switch", { name: /group link/i });
    expect(toggle).toBeDisabled();
    // Not yet RESOLVED to disabled — no upsell card while still loading.
    expect(
      screen.queryByText(/sharing an invite link for a saved trip needs pro/i),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(hoisted.create).not.toHaveBeenCalled();
  });

  it("(d) leaves a snapshot-only preview share (no persisted trip) fully open when not entitled", async () => {
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.create.mockResolvedValueOnce({ data: share({ trip_id: null }) });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId={null}
        onClose={() => {}}
      />,
    );

    const toggle = screen.getByRole("switch", { name: /group link/i });
    expect(toggle).not.toBeDisabled();
    expect(
      screen.queryByText(/sharing an invite link for a saved trip needs pro/i),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(hoisted.create).toHaveBeenCalledWith(
        expect.objectContaining({ trip_id: null }),
      );
    });
  });

  it("reactive net: surfaces the upgrade modal (not a raw error) when a persisted-trip create still 403s toggle-forbidden", async () => {
    // Proactively entitled at render time — the gate lets the click through —
    // but a revoke landed between the snapshot and this call, so the backend
    // rejects with the plain (no `code`) toggle-forbidden 403.
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.create.mockRejectedValueOnce(
      new ApiError("Feature unavailable: collaborative_trips", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Feature unavailable: collaborative_trips",
      }),
    );

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    expect(
      await screen.findByRole("dialog", { name: /upgrade required/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unknown error/i)).not.toBeInTheDocument();
  });
});
