import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTripCollabSession } from "./useTripCollabSession";
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

  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
