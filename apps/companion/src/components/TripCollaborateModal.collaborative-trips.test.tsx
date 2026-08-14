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
  invite: vi.fn(),
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
      invite: hoisted.invite,
    },
  };
});

const useFeatureMock = vi.fn(
  (): {
    enabled: boolean;
    isLoading: boolean;
    isError: boolean;
    isSuccess: boolean;
    dataUpdatedAt?: number;
  } => ({
    enabled: true,
    isLoading: false,
    isError: false,
    isSuccess: true,
  }),
);
const useEntitlementsMock = vi.fn(() => ({ tier: "free" as string | null }));
const refetchEntitlementsMock = vi.fn();
// max_trip_collaborators: unlimited+resolved by default so the People-tab
// tests isolate the collaborative_trips TOGGLE gate from the cap gate.
const useLimitMock = vi.fn(() => ({
  limit: null as number | null,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
// Inject `refetch`/`dataUpdatedAt` in the wrapper so per-test overrides that
// only set `tier`/`enabled` still carry them (the reactive net calls refetch,
// and the recovery effect reads dataUpdatedAt).
vi.mock("@/hooks", () => ({
  useFeature: () => {
    const r = useFeatureMock();
    return { ...r, dataUpdatedAt: r.dataUpdatedAt ?? 0 };
  },
  useEntitlements: () => ({
    refetch: refetchEntitlementsMock,
    dataUpdatedAt: 0,
    ...useEntitlementsMock(),
  }),
  useLimit: () => useLimitMock(),
  // UpgradePrompt's Checkout kill-switch gate — live, as in production.
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
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
    hoisted.invite.mockReset().mockResolvedValue({ data: {} });
    useFeatureMock.mockReset().mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReset().mockReturnValue({ tier: "free" });
    useLimitMock.mockReset().mockReturnValue({
      limit: null,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
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

  it("dismisses the share upsell dialog once collaborative_trips is re-enabled", async () => {
    // Error-deferred gate → toggle clickable; the create 403s → the upsell
    // dialog opens (tier known).
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    hoisted.create.mockRejectedValueOnce(
      new ApiError("Feature unavailable: collaborative_trips", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Feature unavailable: collaborative_trips",
      }),
    );

    const { rerender } = render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));
    // The upsell dialog (pro tier → no higher tier → "Limit reached"), scoped
    // by name so it's not the outer collaboration modal (also role=dialog).
    expect(
      await screen.findByRole("dialog", { name: /limit reached/i }),
    ).toBeInTheDocument();

    // Entitlement recovers → the stale upsell dialog must close.
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    rerender(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /limit reached/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("dismisses the share upsell after a fresh enabled snapshot (already-granted race)", async () => {
    // The client snapshot was ENABLED throughout (a create raced a server-side
    // revoke), so no disabled→enabled transition fires. The stale upsell must
    // still clear once a fresh successful snapshot arrives (dataUpdatedAt
    // advances) confirming the feature is granted.
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
      dataUpdatedAt: 1,
    });
    hoisted.create.mockRejectedValueOnce(
      new ApiError("Feature unavailable: collaborative_trips", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Feature unavailable: collaborative_trips",
      }),
    );

    const { rerender } = render(
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
      await screen.findByRole("dialog", { name: /limit reached/i }),
    ).toBeInTheDocument();

    // A fresh /users/me snapshot lands — same enabled value, newer timestamp.
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
      dataUpdatedAt: 2,
    });
    rerender(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /limit reached/i }),
      ).not.toBeInTheDocument(),
    );
  });

  // ── People tab (email invite) ── the backend also gates
  // POST /trips/:tripId/invite on collaborative_trips, so the email-invite
  // control must be gated too, not only the invite-link tab.
  async function openPeopleTab() {
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /people/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));
  }

  it("(people-a) gates the email invite when collaborative_trips is off — disabled + upsell, invite not fired", async () => {
    useEntitlementsMock.mockReturnValue({ tier: "free" });
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
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );
    await openPeopleTab();

    const emailField = await screen.findByLabelText(/invite email address/i);
    fireEvent.change(emailField, { target: { value: "friend@example.com" } });

    const inviteBtn = screen.getByRole("button", { name: /^invite$/i });
    expect(inviteBtn).toBeDisabled();
    expect(
      screen.getByText(/inviting collaborators to a trip needs pro/i),
    ).toBeInTheDocument();

    fireEvent.click(inviteBtn);
    expect(hoisted.invite).not.toHaveBeenCalled();
  });

  it("(people-b) allows the email invite when entitled", async () => {
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });

    render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );
    await openPeopleTab();

    const emailField = await screen.findByLabelText(/invite email address/i);
    fireEvent.change(emailField, { target: { value: "friend@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    await waitFor(() =>
      expect(hoisted.invite).toHaveBeenCalledWith("server-trip-1", {
        email: "friend@example.com",
        role: "editor",
      }),
    );
    expect(
      screen.queryByText(/inviting collaborators to a trip needs pro/i),
    ).not.toBeInTheDocument();
  });

  it("reactive net with an UNKNOWN tier surfaces a visible error, not a silent no-op", async () => {
    // The /users/me lookup itself errored: the feature hook is in an error
    // state (gate defers to the backend) and the tier is null. The upgrade
    // modal only renders under `collabUpgradeOpen && tier`, so routing a
    // toggle-forbidden 403 to it here would swallow the failure silently —
    // the fix falls back to the visible ErrorAlert instead.
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    useEntitlementsMock.mockReset().mockReturnValue({ tier: null });
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

    // Gate deferred to the backend (error state), so the toggle is clickable.
    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));

    // The failure is visible (ErrorAlert), and NO upgrade dialog appears with
    // an unknown tier.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /upgrade required/i }),
    ).not.toBeInTheDocument();
  });

  it("clears the invite link when regeneration is forbidden after a successful revoke", async () => {
    // An existing persisted-trip share → the group link renders ON.
    hoisted.listMine.mockResolvedValue({
      data: { items: [share({ trip_id: "server-trip-1" })], total: 1 },
    });
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    hoisted.revoke.mockResolvedValue({});
    // The revoke lands, then a raced collaborative_trips revoke makes create 403.
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

    // The existing link is visible.
    await screen.findByLabelText(/shareable invite url/i);

    // Revoke & regenerate: revoke succeeds, create 403s.
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));

    // The now-dead link must be gone (share cleared) — not left presented as
    // an active invite.
    await waitFor(() =>
      expect(
        screen.queryByLabelText(/shareable invite url/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows an error (not the upsell) and keeps the link when the REVOKE itself 403s", async () => {
    // The revoke step's own 403 is an owner-only authorization failure, not
    // the collaborative_trips gate — it must surface a plain error and keep
    // the still-live link, never a misleading upgrade prompt.
    hoisted.listMine.mockResolvedValue({
      data: { items: [share({ trip_id: "server-trip-1" })], total: 1 },
    });
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    hoisted.revoke.mockRejectedValueOnce(
      new ApiError("Not the owner of this trip share", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Not the owner of this trip share",
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

    await screen.findByLabelText(/shareable invite url/i);
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));

    // Plain error, no upgrade dialog, and the create was never attempted.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /upgrade required|limit reached/i }),
    ).not.toBeInTheDocument();
    expect(hoisted.create).not.toHaveBeenCalled();
    // The link is still live (revoke failed → share preserved).
    expect(screen.getByLabelText(/shareable invite url/i)).toBeInTheDocument();
  });

  it("clears the invite upsell once collaborative_trips is re-enabled", async () => {
    // People tab, feature in an error state so the gate defers and the button
    // is clickable; the invite then 403s → the toggle-forbidden upsell shows.
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    useFeatureMock.mockReturnValue({
      enabled: false,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    hoisted.invite.mockRejectedValueOnce(
      new ApiError("Feature unavailable: collaborative_trips", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Feature unavailable: collaborative_trips",
      }),
    );

    const { rerender } = render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );
    await openPeopleTab();
    const emailField = await screen.findByLabelText(/invite email address/i);
    fireEvent.change(emailField, { target: { value: "friend@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    expect(
      await screen.findByText(/inviting collaborators to a trip needs pro/i),
    ).toBeInTheDocument();

    // Entitlement recovers (foreground refresh / operator re-enable) → the
    // stale upsell must clear rather than linger under a working button.
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    rerender(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByText(/inviting collaborators to a trip needs pro/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("dismisses the invite upsell after a fresh enabled snapshot (already-granted race)", async () => {
    // People tab, snapshot ENABLED throughout (the invite raced a server-side
    // revoke), so no disabled→enabled transition fires. A fresh successful
    // snapshot (dataUpdatedAt advances) must still clear the stale upsell.
    useEntitlementsMock.mockReturnValue({ tier: "pro" });
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
      dataUpdatedAt: 1,
    });
    hoisted.invite.mockRejectedValueOnce(
      new ApiError("Feature unavailable: collaborative_trips", 403, {
        statusCode: 403,
        error: "Forbidden",
        message: "Feature unavailable: collaborative_trips",
      }),
    );

    const { rerender } = render(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );
    await openPeopleTab();
    const emailField = await screen.findByLabelText(/invite email address/i);
    fireEvent.change(emailField, { target: { value: "friend@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    expect(
      await screen.findByText(/inviting collaborators to a trip needs pro/i),
    ).toBeInTheDocument();

    // A fresh /users/me snapshot lands — same enabled value, newer timestamp.
    useFeatureMock.mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
      dataUpdatedAt: 2,
    });
    rerender(
      <TripCollaborateModal
        open
        trip={minimalTrip}
        serverTripId="server-trip-1"
        currentUserId="me"
        ownerId="me"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByText(/inviting collaborators to a trip needs pro/i),
      ).not.toBeInTheDocument(),
    );
  });
});
