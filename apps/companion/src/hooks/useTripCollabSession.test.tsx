import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTripCollabSession } from "./useTripCollabSession";
import { useAuthStore } from "@/stores/auth";
import type { TripSuggestion } from "@/lib/api";
import type { TripCursorEvent, TripPresenceEvent } from "@/lib/socket";

const hoisted = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  subscribeTrip: vi.fn(),
  unsubscribeTrip: vi.fn(),
  onTripCursor: vi.fn(),
  onTripPresence: vi.fn(),
  onTripSuggestionCreated: vi.fn(),
  onTripSuggestionDeleted: vi.fn(),
  onTripSuggestionVoted: vi.fn(),
  onTripSuggestionResolved: vi.fn(),
  onTripUpdated: vi.fn(),
  onTripDeleted: vi.fn(),
  emitTripCursor: vi.fn(),
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    tripCollabApi: {
      ...actual.tripCollabApi,
      listSuggestions: hoisted.listSuggestions,
    },
  };
});

vi.mock("@/lib/socket", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/socket")>();
  return {
    ...actual,
    subscribeTrip: hoisted.subscribeTrip,
    unsubscribeTrip: hoisted.unsubscribeTrip,
    onTripCursor: hoisted.onTripCursor,
    onTripPresence: hoisted.onTripPresence,
    onTripSuggestionCreated: hoisted.onTripSuggestionCreated,
    onTripSuggestionDeleted: hoisted.onTripSuggestionDeleted,
    onTripSuggestionVoted: hoisted.onTripSuggestionVoted,
    onTripSuggestionResolved: hoisted.onTripSuggestionResolved,
    onTripUpdated: hoisted.onTripUpdated,
    onTripDeleted: hoisted.onTripDeleted,
    emitTripCursor: hoisted.emitTripCursor,
  };
});

function makeSuggestion(
  id: string,
  tripId: string,
  overrides: Partial<TripSuggestion> = {},
): TripSuggestion {
  return {
    id,
    trip_id: tripId,
    trip_day_id: null,
    suggested_by: "member-1",
    suggester_display_name: "Eve",
    road_segment_id: null,
    title: `Suggestion ${id}`,
    description: null,
    lat: 42.7,
    lng: 0.7,
    status: "open",
    up_votes: 0,
    down_votes: 0,
    caller_vote: null,
    created_at: "2026-04-24T10:00:00Z",
    updated_at: "2026-04-24T10:00:00Z",
    ...overrides,
  };
}

describe("useTripCollabSession", () => {
  let cursorCb: ((evt: TripCursorEvent) => void) | undefined;
  let presenceCb: ((evt: TripPresenceEvent) => void) | undefined;
  let createdCb: ((payload: unknown) => void) | undefined;
  let updatedCb: ((payload: unknown) => void) | undefined;
  let deletedCb: ((evt: { trip_id: string }) => void) | undefined;

  beforeEach(() => {
    // The suggestions fetch is gated on a hydrated auth token; seed the
    // store so the hook behaves as it does for a signed-in rider.
    useAuthStore
      .getState()
      .setSession(
        { id: "u-test", email: "test@tarmoto.app", displayName: "Test" },
        "test-access-token",
      );
    hoisted.listSuggestions.mockReset();
    hoisted.subscribeTrip.mockReset();
    hoisted.unsubscribeTrip.mockReset();
    hoisted.emitTripCursor.mockReset();
    cursorCb = undefined;
    presenceCb = undefined;
    createdCb = undefined;
    hoisted.onTripCursor.mockImplementation(
      (cb: (evt: TripCursorEvent) => void) => {
        cursorCb = cb;
        return () => {};
      },
    );
    hoisted.onTripPresence.mockImplementation(
      (cb: (evt: TripPresenceEvent) => void) => {
        presenceCb = cb;
        return () => {};
      },
    );
    hoisted.onTripSuggestionCreated.mockImplementation(
      (cb: (payload: unknown) => void) => {
        createdCb = cb;
        return () => {};
      },
    );
    hoisted.onTripSuggestionDeleted.mockReturnValue(() => {});
    hoisted.onTripSuggestionVoted.mockReturnValue(() => {});
    hoisted.onTripSuggestionResolved.mockReturnValue(() => {});
    updatedCb = undefined;
    deletedCb = undefined;
    hoisted.onTripUpdated.mockImplementation(
      (cb: (payload: unknown) => void) => {
        updatedCb = cb;
        return () => {};
      },
    );
    hoisted.onTripDeleted.mockImplementation(
      (cb: (evt: { trip_id: string }) => void) => {
        deletedCb = cb;
        return () => {};
      },
    );
  });

  afterEach(() => {
    useAuthStore.getState().clearSession();
    vi.clearAllMocks();
  });

  it("defers the suggestions fetch until the auth token is hydrated", async () => {
    // Cold deep-link load (`?tripId=…`): the hook mounts before AuthSync
    // lands the session. Fetching immediately would 401 and leave a
    // permanent "Unauthorized" alert in the collaborate modal.
    useAuthStore.getState().clearSession();
    hoisted.listSuggestions.mockResolvedValue({
      data: [makeSuggestion("s-1", "trip-a")],
    });

    const { result } = renderHook(() => useTripCollabSession("trip-a"));

    expect(hoisted.listSuggestions).not.toHaveBeenCalled();

    // Session lands → the fetch fires with the bearer available.
    act(() => {
      useAuthStore
        .getState()
        .setSession(
          { id: "u-test", email: "test@tarmoto.app", displayName: "Test" },
          "test-access-token",
        );
    });

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(hoisted.listSuggestions).toHaveBeenCalledWith("trip-a");
    expect(result.current.suggestionsError).toBeNull();
  });

  it("clears cursors, presence, and suggestions when serverTripId switches to a new trip", async () => {
    hoisted.listSuggestions.mockResolvedValueOnce({
      data: [makeSuggestion("s-1", "trip-a")],
    });
    let resolveSecond: ((v: { data: TripSuggestion[] }) => void) | undefined;
    hoisted.listSuggestions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ tripId }: { tripId: string | null }) => useTripCollabSession(tripId),
      { initialProps: { tripId: "trip-a" as string | null } },
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    act(() => {
      cursorCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        lat: 1,
        lng: 2,
        at: "2026-04-24T10:00:00Z",
      });
      presenceCb?.({
        user_id: "u-2",
        trip_id: "trip-a",
        online: true,
        at: "2026-04-24T10:00:00Z",
      });
    });
    expect(result.current.cursors.size).toBe(1);
    expect(result.current.presence.size).toBe(1);

    // Switch to a new trip — state MUST reset immediately so the map
    // overlay and modal list don't leak trip-a's data into trip-b.
    rerender({ tripId: "trip-b" });

    expect(result.current.cursors.size).toBe(0);
    expect(result.current.presence.size).toBe(0);
    expect(result.current.suggestions).toHaveLength(0);

    resolveSecond?.({ data: [makeSuggestion("s-2", "trip-b")] });
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0]!.id).toBe("s-2");
  });

  it("ignores broadcasts targeted at a different trip id", async () => {
    hoisted.listSuggestions.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useTripCollabSession("trip-a"));

    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());
    act(() => {
      cursorCb?.({
        user_id: "u-x",
        trip_id: "trip-OTHER",
        lat: 0,
        lng: 0,
        at: "2026-04-24T10:00:00Z",
      });
      createdCb?.(makeSuggestion("s-rogue", "trip-OTHER"));
    });

    expect(result.current.cursors.size).toBe(0);
    expect(result.current.suggestions).toHaveLength(0);
  });

  it("keeps a user online + cursor alive when only one of their sockets disconnects", async () => {
    // Presence events are per-socket, not per-user. A collaborator
    // with two tabs open closing one must NOT flap offline on other
    // members' maps while the other tab is still connected.
    hoisted.listSuggestions.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useTripCollabSession("trip-a"));
    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());

    // User u-1 connects from tab 1 and tab 2, then moves a cursor.
    act(() => {
      presenceCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        online: true,
        at: "2026-04-24T10:00:00Z",
      });
      presenceCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        online: true,
        at: "2026-04-24T10:00:01Z",
      });
      cursorCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        lat: 1,
        lng: 2,
        at: "2026-04-24T10:00:02Z",
      });
    });
    expect(result.current.presence.get("u-1")?.sockets).toBe(2);
    expect(result.current.presence.get("u-1")?.online).toBe(true);
    expect(result.current.cursors.has("u-1")).toBe(true);

    // Tab 1 closes — one socket offline event. User must stay online
    // (sockets drops to 1) and their cursor stays put for the TTL
    // sweep to decide.
    act(() => {
      presenceCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        online: false,
        at: "2026-04-24T10:00:03Z",
      });
    });
    expect(result.current.presence.get("u-1")?.sockets).toBe(1);
    expect(result.current.presence.get("u-1")?.online).toBe(true);
    expect(result.current.cursors.has("u-1")).toBe(true);

    // Tab 2 also closes — now genuinely offline.
    act(() => {
      presenceCb?.({
        user_id: "u-1",
        trip_id: "trip-a",
        online: false,
        at: "2026-04-24T10:00:04Z",
      });
    });
    expect(result.current.presence.get("u-1")?.sockets).toBe(0);
    expect(result.current.presence.get("u-1")?.online).toBe(false);
  });

  it("forwards trip:updated for the active trip to the onTripUpdated callback (US-35)", async () => {
    // Live-edit propagation: another collaborator regenerates / imports
    // the trip and the planner page must re-hydrate without a manual
    // reload.
    hoisted.listSuggestions.mockResolvedValue({ data: [] });
    const onTripUpdated = vi.fn();

    renderHook(() =>
      useTripCollabSession("trip-a", { onTripUpdated, onTripDeleted: vi.fn() }),
    );
    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());

    const detail = { id: "trip-a", days: [] };
    act(() => {
      updatedCb?.(detail);
    });

    expect(onTripUpdated).toHaveBeenCalledTimes(1);
    expect(onTripUpdated).toHaveBeenCalledWith(detail);
  });

  it("ignores trip:updated for a different trip id (cross-trip leak guard)", async () => {
    // The shared socket may carry events for several trips at once
    // (e.g. another tab joined a different room). The hook must
    // filter so a stale or wrong-room broadcast doesn't fire the
    // active trip's callback.
    hoisted.listSuggestions.mockResolvedValue({ data: [] });
    const onTripUpdated = vi.fn();

    renderHook(() =>
      useTripCollabSession("trip-a", { onTripUpdated, onTripDeleted: vi.fn() }),
    );
    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());

    act(() => {
      updatedCb?.({ id: "trip-b", days: [] });
    });

    expect(onTripUpdated).not.toHaveBeenCalled();
  });

  it("forwards trip:deleted for the active trip and ignores other trips", async () => {
    hoisted.listSuggestions.mockResolvedValue({ data: [] });
    const onTripDeleted = vi.fn();

    renderHook(() =>
      useTripCollabSession("trip-a", { onTripUpdated: vi.fn(), onTripDeleted }),
    );
    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());

    act(() => {
      deletedCb?.({ trip_id: "trip-b" });
    });
    expect(onTripDeleted).not.toHaveBeenCalled();

    act(() => {
      deletedCb?.({ trip_id: "trip-a" });
    });
    expect(onTripDeleted).toHaveBeenCalledWith({ trip_id: "trip-a" });
  });

  it("uses the latest callback identity without re-subscribing the socket listener", async () => {
    // Callbacks are captured by ref so a parent re-render that passes a
    // new function identity (typical with inline arrows) does NOT tear
    // down and re-attach the underlying socket listener — that would
    // briefly drop events between unsubscribe and re-subscribe.
    hoisted.listSuggestions.mockResolvedValue({ data: [] });

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (payload: unknown) => void }) =>
        useTripCollabSession("trip-a", { onTripUpdated: cb }),
      { initialProps: { cb: firstCallback } },
    );
    await waitFor(() => expect(hoisted.subscribeTrip).toHaveBeenCalled());
    const initialUpdatedSubscriptions = hoisted.onTripUpdated.mock.calls.length;

    rerender({ cb: secondCallback });

    // No re-subscription on callback-only changes.
    expect(hoisted.onTripUpdated.mock.calls.length).toBe(
      initialUpdatedSubscriptions,
    );

    act(() => {
      updatedCb?.({ id: "trip-a" });
    });
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });
});
