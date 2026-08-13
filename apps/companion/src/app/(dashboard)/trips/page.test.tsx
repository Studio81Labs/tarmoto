import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TripsPage from "./page";
import { useTripStore } from "@/stores/trip";
import { useAuthStore } from "@/stores/auth";
import { tripsApi, tripFoldersApi, ApiError } from "@/lib/api";
import { withQueryClient } from "@/hooks/test-utils";
import type { TripSummaryWire } from "@/lib/trip-from-detail";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";
import { FormatProvider } from "@/format/FormatProvider";
import type { TripFolder } from "@/lib/trip-folders";

// --- entitlement mocks (add alongside the existing page mocks) ---
const useLimitMock = vi.fn();
const useEntitlementsMock = vi.fn();
vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useEntitlements: () => useEntitlementsMock(),
  useLimit: (key: string) => useLimitMock(key),
  // UpgradePrompt's Checkout kill-switch gate — live, as in production.
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
}));

// Kill switches fail SAFE (enabled until a confirmed `force_off`); empty means
// all on, matching production.
const killSwitches: Record<string, boolean> = vi.hoisted(() => ({}));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Stub the trip + folder API surface the list page's mount effects hit.
// Spread the real module so ApiError / other exports the page (transitively)
// needs still resolve.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripsApi: {
      ...actual.tripsApi,
      list: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    tripFoldersApi: {
      ...actual.tripFoldersApi,
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// One open (draft) trip owned by "me" — the exact shape the list endpoint
// returns (`TripSummaryDto`), adapted by the page's own `tripSummaryFromWire`.
function buildOpenOwnedTripWire(): TripSummaryWire {
  return {
    id: "trip-1",
    title: "Alpine loop",
    status: "draft",
    num_days: 3,
    member_count: 1,
    region: null,
    owner_id: "me",
    folder_id: null,
    created_at: "2026-04-23T09:00:00Z",
  } as TripSummaryWire;
}

function folder(
  overrides: Partial<TripFolder> & Pick<TripFolder, "id" | "name">,
): TripFolder {
  return {
    user_id: "me",
    color: null,
    position: 0,
    created_at: "2026-04-23T09:00:00Z",
    updated_at: "2026-04-23T09:00:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function TripsWithLocale({ locale }: { locale: string }) {
  return (
    <FormatProvider
      formatLocale={locale}
      timeZone="Europe/Prague"
      units="metric"
    >
      <TripsPage />
    </FormatProvider>
  );
}

describe("trips page — max_active_trips gate", () => {
  const tripsApiListMock = vi.mocked(tripsApi.list);
  const tripFoldersListMock = vi.mocked(tripFoldersApi.list);
  const tripsApiDuplicateMock = vi.mocked(tripsApi.duplicate);

  beforeEach(() => {
    for (const key of Object.keys(killSwitches)) delete killSwitches[key];
    useLimitMock.mockReset();
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
    tripsApiListMock.mockReset();
    tripFoldersListMock.mockReset();
    tripsApiDuplicateMock.mockReset();
    useTripStore.setState(useTripStore.getInitialState());
    useAuthStore.setState({
      user: { id: "me", email: "me@example.com", displayName: "Me" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
    tripFoldersListMock.mockResolvedValue({ data: { items: [] } } as never);
    tripsApiListMock.mockResolvedValue({
      data: { data: [buildOpenOwnedTripWire()] },
    } as never);
  });

  it("blocks minting and shows the counter when at the limit", async () => {
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isSuccess: true,
    });

    render(<TripsPage />, { wrapper: withQueryClient() });

    expect(
      await screen.findByText(/1 of 1 trip used on the Free plan/i),
    ).toBeTruthy();
    // The "New trip" and "Import GPX" controls are disabled buttons (not
    // enabled links) — both entry points must be blocked, not just one.
    const newTrip = screen.getByRole("button", { name: /New trip/i });
    expect(newTrip).toHaveProperty("disabled", true);
    const importGpx = screen.getByRole("button", { name: /Import GPX/i });
    expect(importGpx).toHaveProperty("disabled", true);
  });

  it("suppresses the empty-state Create CTA when the cap is zero (kill-switch override)", async () => {
    // An admin override can resolve max_active_trips to 0, making atTripLimit
    // true even with no trips. The header buttons are disabled, but the no-trips
    // empty state must not offer a working "Create trip" link that slips the
    // rider into the planner before the backend rejects the save.
    useLimitMock.mockReturnValue({
      limit: 0,
      isLoading: false,
      isSuccess: true,
    });
    tripsApiListMock.mockResolvedValue({ data: { data: [] } } as never);

    render(<TripsPage />, { wrapper: withQueryClient() });

    expect(await screen.findByText("No trips yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Create trip/i })).toBeNull();
    // The header New trip control is a disabled button, not a link, too.
    expect(screen.queryByRole("link", { name: /New trip/i })).toBeNull();
  });

  it("keeps mint controls disabled while the resolved limit is still loading", async () => {
    // Until the cap resolves, atTripLimit reads a false negative; a capped
    // rider must not be able to click New trip in the load window.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: true,
      isSuccess: false,
    });

    render(<TripsPage />, { wrapper: withQueryClient() });

    // Even once the trip list has resolved, an unresolved limit keeps mint
    // blocked — the controls are disabled buttons, not enabled links.
    await waitFor(() =>
      expect(screen.getByText("Alpine loop")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /New trip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /New trip/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("blocks minting before entitlements resolve (auth not hydrated: not loading, not errored, not resolved)", async () => {
    // Before AuthSync hydrates the store, the /users/me query is disabled and
    // reports isLoading:false/isError:false while producing no snapshot. That
    // must NOT read as "unlimited" — fail closed until it actually resolves.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isError: false,
      isSuccess: false,
    });

    render(<TripsPage />, { wrapper: withQueryClient() });

    await waitFor(() =>
      expect(screen.getByText("Alpine loop")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /New trip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /New trip/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("blocks minting when the entitlement query errors (unknown cap, fail closed)", async () => {
    // A transient /users/me failure leaves the cap unknown — it must not read
    // as unlimited and reopen mint controls for an already-capped rider.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });

    render(<TripsPage />, { wrapper: withQueryClient() });

    await waitFor(() =>
      expect(screen.getByText("Alpine loop")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /New trip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /New trip/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("blocks minting under a FINITE cap when the trip list fails to load (unknown count)", async () => {
    // Finite cap → the count matters, so an unknown count must fail closed.
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    tripsApiListMock.mockRejectedValue(new Error("network"));

    render(<TripsPage />, { wrapper: withQueryClient() });

    await screen.findByText("Couldn't load your trips. Check your connection.");
    expect(screen.queryByRole("link", { name: /New trip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /New trip/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("leaves minting enabled for UNLIMITED riders even when the trip list fails to load", async () => {
    // Cap resolved to null (unlimited) → the count is irrelevant; a /trips
    // outage must not regress an unlimited rider's New trip / Import controls.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    tripsApiListMock.mockRejectedValue(new Error("network"));

    render(<TripsPage />, { wrapper: withQueryClient() });

    await screen.findByText("Couldn't load your trips. Check your connection.");
    expect(screen.getByRole("link", { name: /New trip/i })).toBeTruthy();
  });

  it("leaves minting enabled when the limit is unlimited", async () => {
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });

    render(<TripsPage />, { wrapper: withQueryClient() });

    await waitFor(() =>
      expect(screen.getByText("Alpine loop")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/trips used on the/i)).toBeNull();
    expect(screen.getByRole("link", { name: /New trip/i })).toBeTruthy();
  });

  // Drives the real Copy/Duplicate menu action (row kebab → "Duplicate")
  // rather than calling the handler directly — proves the wiring from the
  // actual UI entry point through to the modal, not just the pure branch.
  const duplicateActiveTrip = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: /Trip actions for Alpine loop/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  };

  it("removes Duplicate when trip planning is killed — it mints a new trip", async () => {
    // Duplication is a CREATE path, so the switch that stops planning has to
    // stop it too. Gating the creation links and leaving this action in the
    // kebab menu meant a rider could keep minting drafts through /trips.
    killSwitches.trip_planning = false;
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    render(<TripsPage />, { wrapper: withQueryClient() });
    await screen.findByText("Alpine loop");
    await userEvent.click(
      screen.getByRole("button", { name: /Trip actions for Alpine loop/i }),
    );
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    // The other row actions are unrelated to planning and stay.
    expect(screen.getByText("Move to folder")).toBeInTheDocument();
    expect(tripsApiDuplicateMock).not.toHaveBeenCalled();
  });

  it("drops the GPX import link when the PLANNER is killed but importing is not", async () => {
    // The link points at `/trips/planner?import=1`. `gpx_import` is the action
    // and `trip_planning` is the destination; either one killed makes it a trip
    // to the planner's unavailable card.
    killSwitches.trip_planning = false;
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    render(<TripsPage />, { wrapper: withQueryClient() });
    await screen.findByText("Alpine loop");
    expect(screen.queryByRole("link", { name: /import gpx/i })).toBeNull();
  });

  it("drops the trip card's quality indicator when the overlay is killed", async () => {
    // The catalog card carries a `QualityBars` glyph derived from
    // `trip.quality_avg`. Cards stay readable — a trip is not a quality feature
    // — but their road-quality signal follows the same kill as the saved-trip
    // summary and the day cards.
    killSwitches.road_quality_overlay = false;
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    const { container } = render(<TripsPage />, {
      wrapper: withQueryClient(),
    });
    await screen.findByText("Alpine loop");
    // Anchored on a testid, not a role: the glyph sits inside an `aria-hidden`
    // wrapper, so role queries skip it and would report it missing whether it
    // rendered or not — which is how the first version of this test passed
    // against an ungated component.
    expect(container.querySelector('[data-testid="trip-card-quality"]')).toBe(
      null,
    );
  });

  it("shows the trip card's quality indicator normally", async () => {
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    const { container } = render(<TripsPage />, {
      wrapper: withQueryClient(),
    });
    await screen.findByText("Alpine loop");
    expect(
      container.querySelector('[data-testid="trip-card-quality"]'),
    ).not.toBeNull();
  });

  it("opens the upgrade modal when duplicate hits the server's feature-limit 403, even though the client thought minting was allowed", async () => {
    // Limit is unlimited on the client — the proactive block never fires.
    // The backend is still the source of truth: it rejects with the real
    // featureLimitExceeded 403, and the safety net must catch it anyway.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    tripsApiDuplicateMock.mockRejectedValue(
      new ApiError("Feature limit exceeded", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_active_trips",
        limit: 1,
        current: 1,
      }),
    );

    render(<TripsPage />, { wrapper: withQueryClient() });
    await screen.findByText("Alpine loop");

    await duplicateActiveTrip();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("You've reached your trip limit on the Free plan."),
    ).toBeInTheDocument();
    // The client cache said unlimited (null), but the modal's CTA derives from
    // the 403's AUTHORITATIVE limit (1) — a Free rider still gets Upgrade to Pro.
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the generic error banner (no modal) when tier hasn't resolved yet for a limit-error duplicate", async () => {
    // Mirrors the 403-with-tier test above, but `useEntitlements` hasn't
    // resolved a tier yet. The upgrade modal requires `tier` to render its
    // message, so without this fallback the rider would get no feedback at
    // all after the click — a silent no-op.
    useEntitlementsMock.mockReturnValue({ tier: null });
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    tripsApiDuplicateMock.mockRejectedValue(
      new ApiError("Feature limit exceeded", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_active_trips",
        limit: 1,
        current: 1,
      }),
    );

    render(<TripsPage />, { wrapper: withQueryClient() });
    await screen.findByText("Alpine loop");

    await duplicateActiveTrip();

    expect(
      await screen.findByText("Couldn't duplicate the trip. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("falls back to the generic error banner (no modal) for a non-limit duplicate failure", async () => {
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    tripsApiDuplicateMock.mockRejectedValue(new Error("boom"));

    render(<TripsPage />, { wrapper: withQueryClient() });
    await screen.findByText("Alpine loop");

    await duplicateActiveTrip();

    expect(
      await screen.findByText("Couldn't duplicate the trip. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("trips page — locale-safe folder mutations", () => {
  const tripsApiListMock = vi.mocked(tripsApi.list);
  const tripFoldersListMock = vi.mocked(tripFoldersApi.list);
  const tripFoldersCreateMock = vi.mocked(tripFoldersApi.create);
  const tripFoldersUpdateMock = vi.mocked(tripFoldersApi.update);

  beforeEach(() => {
    window.localStorage.clear();
    useLimitMock.mockReset();
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReset();
    useEntitlementsMock.mockReturnValue({ tier: "free" });
    tripsApiListMock.mockReset();
    tripsApiListMock.mockResolvedValue({
      data: { data: [buildOpenOwnedTripWire()] },
    } as never);
    tripFoldersListMock.mockReset();
    tripFoldersCreateMock.mockReset();
    tripFoldersUpdateMock.mockReset();
    useTripStore.setState(useTripStore.getInitialState());
    useAuthStore.setState({
      user: { id: "me", email: "me@example.com", displayName: "Me" },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
  });

  it("sorts a completed folder create with the locale active at completion", async () => {
    const zRoad = folder({ id: "z-road", name: "Z-road" });
    const aLand = folder({ id: "a-ring", name: "Åland" });
    tripFoldersListMock.mockResolvedValue({
      data: { items: [zRoad] },
    } as never);
    const createRequest =
      deferred<Awaited<ReturnType<typeof tripFoldersApi.create>>>();
    tripFoldersCreateMock.mockReturnValue(createRequest.promise);

    const view = render(<TripsWithLocale locale="en" />, {
      wrapper: withQueryClient(),
    });
    await screen.findByText("Z-road");

    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Åland");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Åland");

    view.rerender(<TripsWithLocale locale="sv" />);
    await act(async () => {
      createRequest.resolve({ data: aLand });
      await createRequest.promise;
    });

    await waitFor(() => {
      const zRoadLabel = screen.getByText("Z-road");
      const aLandLabel = screen.getByText("Åland");
      expect(
        zRoadLabel.compareDocumentPosition(aLandLabel) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it("sorts a completed folder rename with the locale active at completion", async () => {
    const alps = folder({ id: "alps", name: "Alps" });
    const zRoad = folder({ id: "z-road", name: "Z-road" });
    const renamed = folder({ id: alps.id, name: "Åland" });
    tripFoldersListMock.mockResolvedValue({
      data: { items: [alps, zRoad] },
    } as never);
    const updateRequest =
      deferred<Awaited<ReturnType<typeof tripFoldersApi.update>>>();
    tripFoldersUpdateMock.mockReturnValue(updateRequest.promise);

    const view = render(<TripsWithLocale locale="en" />, {
      wrapper: withQueryClient(),
    });
    await screen.findByText("Alps");

    await userEvent.click(
      screen.getByRole("button", { name: "Folder actions for Alps" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Åland");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    view.rerender(<TripsWithLocale locale="sv" />);
    await act(async () => {
      updateRequest.resolve({ data: renamed });
      await updateRequest.promise;
    });

    await waitFor(() => {
      const zRoadLabel = screen.getByText("Z-road");
      const aLandLabel = screen.getByText("Åland");
      expect(
        zRoadLabel.compareDocumentPosition(aLandLabel) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });
});
