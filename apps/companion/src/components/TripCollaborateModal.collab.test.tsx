import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripCollaborateModal } from "@/components/TripCollaborateModal";
import type { Trip } from "@/lib/types";
import type { TripActivityEntry, TripSuggestion } from "@/lib/api";

const makeTrip = (overrides: Partial<Trip> = {}): Trip => ({
  id: "trip-1",
  name: "Pyrenees Loop",
  status: "planned",
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
  deleteSuggestion: vi.fn(),
  listActivity: vi.fn(),
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
      deleteSuggestion: hoisted.deleteSuggestion,
      listActivity: hoisted.listActivity,
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
    hoisted.deleteSuggestion.mockReset();
    hoisted.listActivity.mockReset().mockResolvedValue({
      data: { activity: [baseActivity] },
    });
    hoisted.subscribeTrip.mockReset();
    hoisted.unsubscribeTrip.mockReset();
    hoisted.onTripActivity.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
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

  it("anchors the created suggestion at the trip's first waypoint so the map overlay can render it", async () => {
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
      expect(hoisted.createSuggestion).toHaveBeenCalledWith(
        "server-trip-1",
        expect.objectContaining({ lat: 42.7, lng: 0.7 }),
      );
    });
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

    expect(await screen.findByText(/activity api 500/i)).toBeInTheDocument();
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
        onClose={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /create invite link/i }),
    );
    expect(await screen.findByText(/invite api down/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /suggestions/i }));
    expect(screen.queryByText(/invite api down/i)).not.toBeInTheDocument();
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

    expect(await screen.findByText(/eve joined the trip/i)).toBeInTheDocument();
  });
});
