import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import type { Trip } from "@/lib/types";
import {
  ApiError,
  type TripActivityEntry,
  type TripSuggestion,
} from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED } from "@tarmoto/shared";

const makeTrip = (overrides: Partial<Trip> = {}): Trip => ({
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
  ...overrides,
});

const hoisted = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  createSuggestion: vi.fn(),
  voteSuggestion: vi.fn(),
  unvoteSuggestion: vi.fn(),
  acceptSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  reopenSuggestion: vi.fn(),
  deleteSuggestion: vi.fn(),
  listActivity: vi.fn(),
  invite: vi.fn(),
  listMembers: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  revokeInvite: vi.fn(),
  listMine: vi.fn(),
  subscribeTrip: vi.fn(),
  unsubscribeTrip: vi.fn(),
  onTripActivity: vi.fn(),
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripCollabApi: {
      listSuggestions: hoisted.listSuggestions,
      createSuggestion: hoisted.createSuggestion,
      voteSuggestion: hoisted.voteSuggestion,
      unvoteSuggestion: hoisted.unvoteSuggestion,
      acceptSuggestion: hoisted.acceptSuggestion,
      rejectSuggestion: hoisted.rejectSuggestion,
      reopenSuggestion: hoisted.reopenSuggestion,
      deleteSuggestion: hoisted.deleteSuggestion,
      listActivity: hoisted.listActivity,
      invite: hoisted.invite,
      listMembers: hoisted.listMembers,
      updateMemberRole: hoisted.updateMemberRole,
      removeMember: hoisted.removeMember,
      revokeInvite: hoisted.revokeInvite,
    },
    tripSharesApi: {
      ...actual.tripSharesApi,
      listMine: hoisted.listMine,
    },
  };
});

vi.mock("@/lib/socket", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/socket")>();
  return {
    ...actual,
    subscribeTrip: hoisted.subscribeTrip,
    unsubscribeTrip: hoisted.unsubscribeTrip,
    onTripActivity: hoisted.onTripActivity,
  };
});

const useLimitMock = vi.fn(() => ({
  limit: null as number | null,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
const useEntitlementsMock = vi.fn(() => ({
  tier: "free" as string | null,
}));
// This file exercises the People / Suggestions / Activity tabs, not the
// `collaborative_trips` toggle gate (US-C2, covered in
// `TripCollaborateModal.collaborative-trips.test.tsx`) — default to fully
// entitled/resolved so none of these cases trip the new proactive gate on
// the (always-persisted, `serverTripId="server-trip-1"`) fixtures here.
const useFeatureMock = vi.fn(() => ({
  enabled: true,
  isLoading: false,
  isError: false,
  isSuccess: true,
}));
vi.mock("@/hooks", () => ({
  useLimit: () => useLimitMock(),
  useEntitlements: () => ({
    refetch: vi.fn(),
    dataUpdatedAt: 0,
    ...useEntitlementsMock(),
  }),
  useFeature: () => ({ dataUpdatedAt: 0, ...useFeatureMock() }),
}));

// UpgradePrompt (rendered by the at-cap counter / 403 modal) calls
// useRouter() for its CTA — the test tree has no app router mounted.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const baseSuggestion: TripSuggestion = {
  id: "sug-1",
  trip_id: "server-trip-1",
  trip_day_id: null,
  suggested_by: "member-1",
  suggester_display_name: "Eve",
  road_segment_id: null,
  title: "Scenic pass alt",
  description: null,
  lat: 42.7,
  lng: 0.7,
  status: "open",
  up_votes: 0,
  down_votes: 0,
  caller_vote: null,
  created_at: "2026-04-24T10:00:00Z",
  updated_at: "2026-04-24T10:00:00Z",
};

const baseActivity: TripActivityEntry = {
  id: "a-1",
  trip_id: "server-trip-1",
  actor_id: "member-1",
  actor_name: "Eve",
  action: "member_joined",
  payload: { role: "member" },
  created_at: new Date().toISOString(),
};

describe("TripCollaborateModal — collab tabs", () => {
  beforeEach(() => {
    hoisted.listSuggestions.mockReset().mockResolvedValue({
      data: [baseSuggestion],
    });
    hoisted.createSuggestion.mockReset();
    hoisted.voteSuggestion.mockReset();
    hoisted.unvoteSuggestion.mockReset();
    hoisted.acceptSuggestion.mockReset();
    hoisted.rejectSuggestion.mockReset();
    hoisted.reopenSuggestion.mockReset();
    hoisted.deleteSuggestion.mockReset();
    hoisted.listActivity.mockReset().mockResolvedValue({
      data: { activity: [baseActivity] },
    });
    hoisted.invite.mockReset();
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: { members: [], invites: [] },
    });
    hoisted.updateMemberRole.mockReset();
    hoisted.removeMember.mockReset();
    hoisted.revokeInvite.mockReset();
    hoisted.listMine
      .mockReset()
      .mockResolvedValue({ data: { items: [], total: 0 } });
    hoisted.subscribeTrip.mockReset();
    hoisted.unsubscribeTrip.mockReset();
    hoisted.onTripActivity.mockReset().mockReturnValue(() => {});
    useLimitMock.mockReset().mockReturnValue({
      limit: null,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    useEntitlementsMock.mockReset().mockReturnValue({ tier: "free" });
    useFeatureMock.mockReset().mockReturnValue({
      enabled: true,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("prompts to save trip when opening Suggestions tab without serverTripId", async () => {
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId={null}
        currentUserId="member-1"
        ownerId={null}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    expect(
      await screen.findByText(/collaborative suggestions need a saved trip/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /save trip and enable collaboration/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows existing suggestions and allows voting up when a server trip is attached", async () => {
    hoisted.voteSuggestion.mockResolvedValueOnce({
      data: { ...baseSuggestion, up_votes: 1, caller_vote: "up" },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    expect(await screen.findByText("Scenic pass alt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /vote up/i }));

    await waitFor(() => {
      expect(hoisted.voteSuggestion).toHaveBeenCalledWith(
        "server-trip-1",
        "sug-1",
        "up",
      );
    });
  });

  it("suggestions-only mode drops the tab bar and the redundant propose header", async () => {
    render(
      <TripCollaborateModal
        open
        mode="suggestions"
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    // Suggestions surface only — no invite/people/activity tabs.
    expect(
      screen.queryByRole("tab", { name: /invite link/i }),
    ).not.toBeInTheDocument();
    // The dialog header already says "Suggestions", so the in-box
    // "Propose an alternative" heading is dropped — the form stays.
    expect(
      screen.queryByRole("heading", { name: /propose an alternative/i }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByLabelText(/suggestion title/i),
    ).toBeInTheDocument();
  });

  it("shows accept/reject buttons for the trip owner", async () => {
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    expect(
      await screen.findByRole("button", { name: /^accept$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^reject$/i }),
    ).toBeInTheDocument();
  });

  it("hides accept/reject from non-owners", async () => {
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    await screen.findByText("Scenic pass alt");

    expect(
      screen.queryByRole("button", { name: /^accept$/i }),
    ).not.toBeInTheDocument();
  });

  it("submits a new suggestion with the typed title and description", async () => {
    hoisted.createSuggestion.mockResolvedValueOnce({
      data: { ...baseSuggestion, id: "sug-new", title: "My alternative" },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    await screen.findByText("Scenic pass alt");

    fireEvent.change(screen.getByLabelText(/suggestion title/i), {
      target: { value: "My alternative" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit suggestion/i }));

    await waitFor(() => {
      expect(hoisted.createSuggestion).toHaveBeenCalledWith(
        "server-trip-1",
        expect.objectContaining({ title: "My alternative" }),
      );
    });
  });

  it("creates a text suggestion with no coordinates (no auto-anchor to the start)", async () => {
    // Without a lat/lng, the buildSuggestionCollection builder drops
    // the suggestion from the map overlay. Anchor at the start of the
    // first day so members see the proposal as a marker by default.
    hoisted.createSuggestion.mockResolvedValueOnce({
      data: { ...baseSuggestion, id: "sug-new", lat: 42.7, lng: 0.7 },
    });

    const trip = makeTrip({
      days: [
        {
          dayNumber: 1,
          waypoints: [
            {
              id: "wp-start",
              name: "Start",
              location: { lat: 42.7, lng: 0.7 },
              type: "start",
            },
            {
              id: "wp-end",
              name: "End",
              location: { lat: 42.8, lng: 0.9 },
              type: "end",
            },
          ],
          distanceKm: 0,
          durationMinutes: 0,
          elevationGain: 0,
          avgQuality: 0,
        },
      ],
    });

    render(
      <TripCollaborateModal
        open
        trip={trip}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    await screen.findByText("Scenic pass alt");

    fireEvent.change(screen.getByLabelText(/suggestion title/i), {
      target: { value: "Via the pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit suggestion/i }));

    await waitFor(() => {
      expect(hoisted.createSuggestion).toHaveBeenCalled();
    });
    // No auto-anchor: a text suggestion carries no lat/lng (it lives in the
    // list, not as a violet dot parked at the start waypoint).
    const body = hoisted.createSuggestion.mock.calls[0]?.[1];
    expect(body).not.toHaveProperty("lat");
    expect(body).not.toHaveProperty("lng");
  });

  it("hides the propose form when trip is null so cold ?tripId= opens can't submit coordless suggestions", async () => {
    render(
      <TripCollaborateModal
        open
        trip={null}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    await screen.findByText("Scenic pass alt");

    // The form inputs must not be rendered at all — just the list +
    // vote buttons + a hint pointing at the planner.
    expect(
      screen.queryByLabelText(/suggestion title/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit suggestion/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/load the trip into the planner to propose/i),
    ).toBeInTheDocument();
  });

  it("surfaces the hook's suggestionsError through the SuggestionsTab instead of empty-state", async () => {
    // When the modal reads shared suggestions from useTripCollabSession
    // and that hook's fetch fails, it sets `suggestionsError`. Without
    // surfacing it here the user would see "No suggestions yet" and
    // silently miss auth/network/server failures.
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        suggestions={[]}
        onSuggestionsChange={vi.fn()}
        suggestionsError="Failed to load suggestions — 503"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    expect(
      await screen.findByText(/failed to load suggestions — 503/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no suggestions yet/i)).not.toBeInTheDocument();
  });

  it("surfaces activity fetch errors as an alert instead of the empty-state message", async () => {
    // Without this fix, a network / auth failure on initial load would
    // render "No activity yet" — indistinguishable from a genuinely
    // empty timeline, giving the user no actionable feedback.
    hoisted.listActivity
      .mockReset()
      .mockRejectedValueOnce(new Error("Activity API 500"));

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    expect(await screen.findByText("Unknown error")).toBeInTheDocument();
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument();
  });

  it("clears a parent-level invite error when switching tabs so it doesn't bleed into Suggestions/Activity", async () => {
    // Reproduce the leak: invite tab fires handleGenerate, errors out,
    // and the alert lives in the parent div next to the active tab.
    // Switching tabs must drop the error; otherwise a user sees an
    // out-of-context invite failure while browsing suggestions.
    const { tripSharesApi } = await import("@/lib/api");
    const createSpy = vi
      .spyOn(tripSharesApi, "create")
      .mockRejectedValueOnce(new Error("Invite API down"));

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /group link/i }));
    expect(await screen.findByText("Unknown error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    expect(screen.queryByText("Unknown error")).not.toBeInTheDocument();
    createSpy.mockRestore();
  });

  it("deduplicates when the broadcast landed the row before the POST resolved", async () => {
    // Pre-load the list with what the socket "already delivered".
    hoisted.listSuggestions.mockResolvedValueOnce({
      data: [{ ...baseSuggestion, id: "sug-new", title: "Race route" }],
    });
    hoisted.createSuggestion.mockResolvedValueOnce({
      data: { ...baseSuggestion, id: "sug-new", title: "Race route" },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    await screen.findByText("Race route");

    fireEvent.change(screen.getByLabelText(/suggestion title/i), {
      target: { value: "Race route" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit suggestion/i }));

    // List stays at 1 — the create response replaces the existing row
    // in place rather than prepending a duplicate.
    await waitFor(() => {
      const matches = screen.getAllByText("Race route");
      expect(matches).toHaveLength(1);
    });
  });

  it("keeps the suggestions list visible when trip is null but serverTripId is set", async () => {
    render(
      <TripCollaborateModal
        open
        trip={null}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    // The list + vote buttons must still render for a collaborator who
    // opened a shared ?tripId= URL cold.
    expect(await screen.findByText("Scenic pass alt")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /vote up/i }),
    ).toBeInTheDocument();
  });

  it("renders the activity timeline when server trip is attached", async () => {
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    // The row renders the actor bold and the action clause next to it.
    expect(await screen.findByText(/joined the trip/i)).toBeInTheDocument();
    expect(screen.getByText("Eve")).toBeInTheDocument();
  });

  it("keeps a live trip:activity entry that arrived before listActivity resolved", async () => {
    // Reproduce the race: the socket listener fires while the REST
    // fetch is still in flight. The pre-fix code used
    // `setEntries(data.activity)` which wholesale-replaced the array,
    // silently dropping the live entry until a user refresh.
    let resolveFetch: (value: {
      data: { activity: TripActivityEntry[] };
    }) => void = () => {};
    hoisted.listActivity.mockReset().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    let activityHandler: ((payload: unknown) => void) | null = null;
    hoisted.onTripActivity.mockReset().mockImplementation((cb) => {
      activityHandler = cb as (payload: unknown) => void;
      return () => {};
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    // Socket event lands DURING the fetch.
    expect(activityHandler).not.toBeNull();
    activityHandler!({
      id: "a-live",
      trip_id: "server-trip-1",
      actor_id: "member-2",
      actor_name: "Bob",
      action: "suggestion_voted",
      payload: { vote: "up" },
      created_at: new Date().toISOString(),
    });

    // REST response lands AFTER the live event and carries an older
    // historical entry that the live one isn't part of.
    resolveFetch({ data: { activity: [baseActivity] } });

    // Both entries must be visible — the live vote stays on top, the
    // fetched historical entry renders below it.
    expect(await screen.findByText(/voted up/i)).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText(/joined the trip/i)).toBeInTheDocument();
    expect(screen.getByText("Eve")).toBeInTheDocument();
  });

  it("renders a cataloged fallback without exposing an unknown action token", async () => {
    // Backend releases can introduce a new TripActivityAction value
    // before the companion redeploys. Without a default case the
    // switch returned undefined and the timeline row rendered blank.
    hoisted.listActivity.mockReset().mockResolvedValue({
      data: {
        activity: [
          {
            ...baseActivity,
            id: "a-future",
            action: "suggestion_archived" as never,
            payload: {},
          },
        ],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    expect(
      await screen.findByText(
        /performed an activity that this app version cannot describe/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/suggestion archived/i)).not.toBeInTheDocument();
    expect(screen.getByText("Eve")).toBeInTheDocument();
  });

  it("pages long suggestion lists behind a Show more button", async () => {
    hoisted.listSuggestions.mockResolvedValueOnce({
      data: Array.from({ length: 7 }, (_, i) => ({
        ...baseSuggestion,
        id: `sug-${i + 1}`,
        title: `Alternative ${i + 1}`,
      })),
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    // First page only (5 cards), with the cut-off called out.
    expect(await screen.findByText("Alternative 1")).toBeInTheDocument();
    expect(screen.getByText("Alternative 5")).toBeInTheDocument();
    expect(screen.queryByText("Alternative 6")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));

    expect(screen.getByText("Alternative 7")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show more/i }),
    ).not.toBeInTheDocument();
  });

  it("pages long activity feeds behind a Show more button", async () => {
    hoisted.listActivity.mockReset().mockResolvedValue({
      data: {
        activity: Array.from({ length: 12 }, (_, i) => ({
          ...baseActivity,
          id: `a-${i + 1}`,
          actor_name: `Rider ${i + 1}`,
        })),
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    expect(await screen.findByText("Rider 1")).toBeInTheDocument();
    expect(screen.getByText("Rider 10")).toBeInTheDocument();
    expect(screen.queryByText("Rider 11")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /show earlier activity/i }),
    );

    expect(screen.getByText("Rider 12")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show earlier activity/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses resolved suggestions behind a summary row and reopens from it", async () => {
    hoisted.listSuggestions.mockResolvedValueOnce({
      data: [
        { ...baseSuggestion, id: "sug-open", title: "Open idea" },
        {
          ...baseSuggestion,
          id: "sug-acc",
          title: "Accepted idea",
          status: "accepted",
        },
        {
          ...baseSuggestion,
          id: "sug-rej",
          title: "Rejected idea",
          status: "rejected",
        },
      ],
    });
    hoisted.reopenSuggestion.mockResolvedValueOnce({
      data: { ...baseSuggestion, id: "sug-acc", title: "Accepted idea" },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    // Open proposals lead; resolved history starts collapsed.
    expect(await screen.findByText("Open idea")).toBeInTheDocument();
    expect(screen.queryByText("Accepted idea")).not.toBeInTheDocument();
    expect(screen.queryByText("Rejected idea")).not.toBeInTheDocument();

    const summary = screen.getByRole("button", {
      name: /2 resolved · 1 accepted/i,
    });
    fireEvent.click(summary);

    expect(screen.getByText("Accepted idea")).toBeInTheDocument();
    expect(screen.getByText("Rejected idea")).toBeInTheDocument();

    // The owner can flip a resolved suggestion back to open.
    fireEvent.click(screen.getAllByRole("button", { name: /^reopen$/i })[0]!);
    await waitFor(() => {
      expect(hoisted.reopenSuggestion).toHaveBeenCalledWith(
        "server-trip-1",
        "sug-acc",
      );
    });
  });

  it("hides Reopen from non-owners on resolved suggestions", async () => {
    hoisted.listSuggestions.mockResolvedValueOnce({
      data: [
        {
          ...baseSuggestion,
          id: "sug-acc",
          title: "Accepted idea",
          status: "accepted",
        },
      ],
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    fireEvent.click(
      await screen.findByRole("button", { name: /1 resolved · 1 accepted/i }),
    );
    expect(screen.getByText("Accepted idea")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^reopen$/i }),
    ).not.toBeInTheDocument();
  });

  it("groups the activity feed under Today / Yesterday / Earlier headers", async () => {
    // Pin the clock to midday so the `hoursAgo` offsets land on deterministic
    // calendar days. Without this, a run in the ~2h after local midnight sorts
    // the "2h ago" row onto the previous day and the "Today" header vanishes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3_600_000).toISOString();
    hoisted.listActivity.mockReset().mockResolvedValue({
      data: {
        activity: [
          { ...baseActivity, id: "a-today", created_at: hoursAgo(2) },
          {
            ...baseActivity,
            id: "a-yesterday",
            actor_name: "Bob",
            created_at: hoursAgo(26),
          },
          {
            ...baseActivity,
            id: "a-earlier",
            actor_name: "Cid",
            created_at: hoursAgo(80),
          },
        ],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    expect(await screen.findByText("Today")).toBeInTheDocument();
    // 26h ago can fall on yesterday or the day before depending on the
    // wall clock; assert the header set loosely — Yesterday OR Earlier
    // must carry the middle row, and Earlier always exists for 80h ago.
    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByText("Eve")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Cid")).toBeInTheDocument();
    // Locks the per-row timestamp itself (not just the day-bucket headers
    // above, which come from a separate, untouched `dayBucket` helper): the
    // "a-today" row is pinned to exactly 2h before the fake system clock, so
    // `format.relativeTime` must render "2h ago" — the migration deleted the
    // local `formatActivityTime` helper's "Yesterday, HH:MM" 24h special case
    // in favour of this single relative-time seam for every row regardless of
    // bucket, and that behavior change needs a real assertion, not just a
    // passing render.
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  });

  it("invites people by email with a role from the People tab", async () => {
    hoisted.invite.mockResolvedValueOnce({ data: { status: "queued" } });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    // react-aria Select: open the trigger button, then click the option.
    fireEvent.click(screen.getByRole("button", { name: /invite role/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /viewer/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("option", { name: /viewer/i }));
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    await waitFor(() => {
      expect(hoisted.invite).toHaveBeenCalledWith("server-trip-1", {
        email: "rider@example.com",
        role: "viewer",
      });
    });
    expect(
      await screen.findByText(/invite sent to rider@example\.com/i),
    ).toBeInTheDocument();
  });

  it("shows the invite form to editors (not just the owner)", async () => {
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "member-1",
            display_name: "Eve",
            email: "eve@example.com",
            avatar_url: null,
            role: "editor",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    // Editors are privileged invite senders on the backend — the form
    // must not be owner-only. Role menus stay hidden for non-owners.
    expect(
      await screen.findByLabelText(/invite email address/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change role for eve/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces an email invite failure inline instead of swallowing it", async () => {
    hoisted.invite.mockRejectedValueOnce(new Error("Invite mail API down"));

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    expect(await screen.findByText("Unknown error")).toBeInTheDocument();
    expect(hoisted.invite).toHaveBeenCalledTimes(1);
  });

  it("shows the save-trip CTA on the People tab when the trip is not saved", () => {
    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId={null}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    expect(
      screen.getByText(/inviting people needs a saved trip/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/invite email address/i),
    ).not.toBeInTheDocument();
  });

  it("renders the roster with owner label, role menus, and pending invites", async () => {
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "owner-1",
            display_name: "Owner Olga",
            email: "olga@example.com",
            avatar_url: null,
            role: "owner",
            joined_at: "2026-07-01T10:00:00Z",
            state: "joined",
          },
          {
            user_id: "member-1",
            display_name: "Eve",
            email: "eve@example.com",
            avatar_url: null,
            role: "editor",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [
          {
            id: "inv-1",
            email: "petr@example.com",
            role: "viewer",
            created_at: "2026-07-03T10:00:00Z",
            state: "invited",
          },
        ],
      },
    });
    hoisted.updateMemberRole.mockResolvedValueOnce({
      data: { members: [], invites: [] },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    expect(await screen.findByText("Eve")).toBeInTheDocument();
    // Caller's own row says "You" with the OWNER mark, no role menu.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText(/^owner$/i)).toBeInTheDocument();
    // Pending invite renders with the PENDING chip.
    expect(screen.getByText("petr@example.com")).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    // The people count badge on the tab reflects members + invites.
    expect(screen.getByRole("tab", { name: /people/i }).textContent).toContain(
      "3",
    );

    // Owner demotes Eve via the role menu.
    fireEvent.click(
      screen.getByRole("button", { name: /change role for eve/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /viewer/i }));
    await waitFor(() => {
      expect(hoisted.updateMemberRole).toHaveBeenCalledWith(
        "server-trip-1",
        "member-1",
        "viewer",
      );
    });
  });

  it("lets the owner remove a member from the role menu", async () => {
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "member-1",
            display_name: "Eve",
            email: null,
            avatar_url: null,
            role: "editor",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });
    hoisted.removeMember.mockResolvedValueOnce({ data: undefined });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.click(
      await screen.findByRole("button", { name: /change role for eve/i }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /remove from trip/i }),
    );

    await waitFor(() => {
      expect(hoisted.removeMember).toHaveBeenCalledWith(
        "server-trip-1",
        "member-1",
      );
    });
  });

  it("lets viewers propose and vote but not moderate", async () => {
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "member-1",
            display_name: "Eve",
            email: null,
            avatar_url: null,
            role: "viewer",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));

    // Viewers now propose and vote like everyone else — the form shows
    // and votes are live (backend opened this surface to all members).
    expect(
      await screen.findByLabelText(/suggestion title/i),
    ).toBeInTheDocument();
    await screen.findByText("Scenic pass alt");
    expect(screen.getByRole("button", { name: /vote up/i })).not.toBeDisabled();
    // But a viewer cannot moderate: no Accept/Reject on open suggestions.
    expect(
      screen.queryByRole("button", { name: /^accept/i }),
    ).not.toBeInTheDocument();
  });

  it("blocks the invite and shows the counter when the OWNER is at the collaborator cap", async () => {
    // Free tier's real max_trip_collaborators default is 0 (see
    // packages/shared/src/feature-flags.ts) — `upgradeTierForLimit` only
    // resolves a CTA target when the resolved limit matches the current
    // tier's static default (a mismatch reads as an override, which
    // suppresses the CTA), so the cap here must be the real free default
    // for the "Upgrade to Pro" assertion below to hold.
    useLimitMock.mockReturnValue({
      limit: 0,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "owner-1",
            display_name: "Owner",
            email: "o@example.com",
            avatar_url: null,
            role: "owner",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    // 0 non-owner collaborators, cap 0 (free tier) → already at limit.
    expect(
      await screen.findByText(/0 of 0 collaborators/i),
    ).toBeInTheDocument();
    // Fill a valid email first — otherwise this assertion would pass even
    // if `atCollaboratorCap` were broken, since an empty email disables the
    // button on its own (`!email.trim()`). Filling it attributes the
    // disable specifically to the collaborator-cap gate.
    fireEvent.change(screen.getByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    const invite = screen.getByRole("button", { name: /^invite$/i });
    expect(invite).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Upgrade to Pro/i }),
    ).toBeInTheDocument();
  });

  it("re-enables Invite for an already-pending address at the cap (net-zero re-invite)", async () => {
    // At cap with one pending invite. A NEW address stays blocked, but
    // re-inviting the already-pending address (case/space-insensitive) is
    // net-zero — the backend exempts it, so the UI must too.
    useLimitMock.mockReturnValue({
      limit: 1,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "owner-1",
            display_name: "Owner",
            email: "o@example.com",
            avatar_url: null,
            role: "owner",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [
          {
            id: "inv-1",
            email: "pending@example.com",
            role: "editor",
            created_at: "2026-07-03T10:00:00Z",
            state: "invited",
          },
        ],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    // 1 pending invite, cap 1 → at cap.
    expect(
      await screen.findByText(/1 of 1 collaborators/i),
    ).toBeInTheDocument();
    const emailInput = screen.getByLabelText(/invite email address/i);
    const invite = screen.getByRole("button", { name: /^invite$/i });

    // A brand-new address is blocked by the cap.
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    expect(invite).toBeDisabled();

    // Re-inviting the already-pending address (padded + mixed case) is allowed.
    fireEvent.change(emailInput, {
      target: { value: "  PENDING@example.com  " },
    });
    expect(invite).not.toBeDisabled();
  });

  it("fails closed: an unresolved cap blocks the OWNER even with an empty roster and a filled email", async () => {
    // isSuccess: false + isError: false = still loading / rolling-deploy
    // omission — NOT "resolved to unlimited". The gate fails closed for the
    // owner here (`!limitResolved && !limitError`), independent of the roster
    // count or limit value. (An ERRORED query is handled separately below.)
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: true,
      isError: false,
      isSuccess: false,
    });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "owner-1",
            display_name: "Owner",
            email: "o@example.com",
            avatar_url: null,
            role: "owner",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    // Zero non-owner collaborators — the ONLY reason to block here is the
    // unresolved cap, not the roster count.
    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    const invite = screen.getByRole("button", { name: /^invite$/i });
    expect(invite).toBeDisabled();
    // Fail-closed blocks the action but doesn't claim a specific limit —
    // no counter or upgrade CTA should render for an unresolved cap.
    expect(screen.queryByText(/collaborators$/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Upgrade to Pro/i }),
    ).not.toBeInTheDocument();
  });

  it("does NOT block the OWNER when the entitlement query ERRORED (defers to the backend)", async () => {
    // A failed /users/me must not disable the invite button forever with no
    // feedback: the cap is unknown, so let the authoritative request run — the
    // backend enforces and returns a 403 the modal surfaces.
    useLimitMock.mockReturnValue({
      limit: null,
      isLoading: false,
      isError: true,
      isSuccess: false,
    });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "owner-1",
            display_name: "Owner",
            email: "o@example.com",
            avatar_url: null,
            role: "owner",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    // Not blocked — the entitlement error defers enforcement to the backend.
    expect(
      screen.getByRole("button", { name: /^invite$/i }),
    ).not.toBeDisabled();
  });

  it("does not proactively block an EDITOR inviting (owner-scoped cap), relies on the 403", async () => {
    useLimitMock.mockReturnValue({
      limit: 0,
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "member-1",
            display_name: "Eve",
            email: "eve@example.com",
            avatar_url: null,
            role: "editor",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    // The editor's own tier isn't the cap's — invite stays enabled proactively.
    const invite = screen.getByRole("button", { name: /^invite$/i });
    expect(invite).not.toBeDisabled();
  });

  it("routes a FEATURE_LIMIT_EXCEEDED invite 403 to the upgrade modal", async () => {
    hoisted.invite.mockRejectedValueOnce(
      new ApiError("limit", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_trip_collaborators",
        limit: 5,
        current: 5,
      }),
    );

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="owner-1"
        ownerId="owner-1"
        canCreateInviteLink
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    // The outer TripCollaborateModal container is ALSO role="dialog"
    // (aria-labelledby "Collaborate on this trip"), so target the inner
    // upgrade dialog by its own accessible name — with resolvedLimit (5)
    // not matching the free tier's static default (0), no upgrade target
    // resolves, so UpgradePrompt's modal titles itself "Limit reached".
    expect(
      await screen.findByRole("dialog", { name: /limit reached/i }),
    ).toBeInTheDocument();
  });

  it("still surfaces the 403 owner-limit message to an EDITOR whose own tier is unavailable", async () => {
    // The editor invites on the OWNER's cap, so /users/me can be unresolved
    // (tier null). A prior `&& tier` render guard swallowed the modal, leaving
    // the failed invite with no feedback — the message must render regardless.
    useEntitlementsMock.mockReturnValue({ tier: null });
    hoisted.listMembers.mockReset().mockResolvedValue({
      data: {
        members: [
          {
            user_id: "member-1",
            display_name: "Eve",
            email: "eve@example.com",
            avatar_url: null,
            role: "editor",
            joined_at: "2026-07-02T10:00:00Z",
            state: "joined",
          },
        ],
        invites: [],
      },
    });
    hoisted.invite.mockRejectedValueOnce(
      new ApiError("limit", 403, {
        code: FEATURE_LIMIT_EXCEEDED,
        feature: "max_trip_collaborators",
        limit: 5,
        current: 5,
      }),
    );

    render(
      <TripCollaborateModal
        open
        trip={makeTrip()}
        serverTripId="server-trip-1"
        currentUserId="member-1"
        ownerId="owner-1"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /people/i }));

    fireEvent.change(await screen.findByLabelText(/invite email address/i), {
      target: { value: "rider@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));

    expect(
      await screen.findByText(
        /the trip owner has reached their collaborator limit/i,
      ),
    ).toBeInTheDocument();
  });
});
