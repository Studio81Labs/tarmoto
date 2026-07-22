import { useCallback, useEffect, useRef, useState } from "react";
import { getUserFacingErrorMessage } from "@/i18n";
import { useTranslation } from "@/i18n/I18nProvider";
import { tripCollabApi, type TripSuggestion } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import {
  emitTripCursor as emitTripCursorSocket,
  onTripCursor,
  onTripDeleted,
  onTripPresence,
  onTripSuggestionCreated,
  onTripSuggestionDeleted,
  onTripSuggestionResolved,
  onTripSuggestionVoted,
  onTripUpdated,
  subscribeTrip,
  unsubscribeTrip,
  type TripCursorEvent,
  type TripDeletedEvent,
  type TripPresenceEvent,
  type TripSuggestionResolvedEvent,
  type TripSuggestionVotedEvent,
} from "@/lib/socket";

/**
 * Live state of another collaborator's cursor in the planner map.
 * Stale cursors are expired after `CURSOR_TTL_MS` so a user who closes
 * the tab doesn't leave a ghost dot on everyone else's map forever.
 */
export interface CollaboratorCursor {
  userId: string;
  lat: number;
  lng: number;
  lastSeenAt: number;
}

/**
 * Display profile for a trip member, keyed by user id. Loaded from the roster
 * so the map can render each collaborator's cursor as their avatar (initials
 * or photo) instead of a raw id.
 */
export interface CollaboratorProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Online presence bookkeeping for the member list. */
export interface CollaboratorPresence {
  userId: string;
  online: boolean;
  /**
   * Count of the user's currently-known open sockets. Tracked so
   * closing a single tab / device doesn't flip `online` to false
   * while another of their sockets is still connected — presence
   * events are per-socket, not per-user.
   */
  sockets: number;
  lastSeenAt: number;
}

const CURSOR_TTL_MS = 10_000;
const CURSOR_EMIT_THROTTLE_MS = 150;
const CURSOR_SWEEP_MS = 2_000;

/**
 * Optional callbacks consumers can wire up to react to live-edit
 * broadcasts (US-35). The planner page uses these to re-hydrate local
 * trip state when another collaborator regenerates / imports / mutates
 * the trip via the REST API, without a manual reload.
 *
 * Kept as plain callbacks rather than re-exposing a "latest update"
 * piece of state because the planner page already owns trip hydration
 * via `setActiveTrip` — pushing it back through React state would
 * double-render and risk clobbering local optimistic edits between the
 * event arriving and the consumer's `useEffect` reacting.
 */
export interface UseTripCollabSessionCallbacks {
  /**
   * Fires when another collaborator commits a trip mutation (import,
   * replace, regenerate). Payload mirrors `TripDetailDto`.
   */
  onTripUpdated?: (detail: unknown) => void;
  /** Fires when the owner deletes the trip. */
  onTripDeleted?: (evt: TripDeletedEvent) => void;
}

/**
 * Hook that wires the planner page to the live trip-collaboration surface.
 *
 * Once `serverTripId` is non-null, it:
 *   • joins the socket room `trip:<id>` (and leaves on unmount)
 *   • maintains maps of live cursors and presence
 *   • owns the shared `suggestions` list (map overlay + modal read from
 *     the same state, avoiding a double-fetch / double-listener pair)
 *   • exposes a throttled `emitCursor(lat, lng)` callback
 *   • forwards `trip:updated` / `trip:deleted` broadcasts to the
 *     caller-supplied callbacks so the planner page can re-hydrate
 *     local trip state on remote edits without a manual reload (US-35)
 *
 * Broadcast payloads carry `caller_vote: null` (the backend can't know
 * each recipient's vote); the merge logic preserves the locally-known
 * `caller_vote` so another member's vote doesn't wipe the caller's own-
 * vote highlight.
 *
 * Switching trips resets cursors/presence/suggestions so cross-trip data
 * never leaks into the new session.
 */
export function useTripCollabSession(
  serverTripId: string | null,
  callbacks: UseTripCollabSessionCallbacks = {},
) {
  const t = useTranslation();
  const [cursors, setCursors] = useState<Map<string, CollaboratorCursor>>(
    () => new Map(),
  );
  const [presence, setPresence] = useState<Map<string, CollaboratorPresence>>(
    () => new Map(),
  );
  const [members, setMembers] = useState<Map<string, CollaboratorProfile>>(
    () => new Map(),
  );
  // Roster refetch bookkeeping: a collaborator who joins AFTER the roster
  // snapshot only shows up in cursor/presence events (user id only). When we
  // see a user id we don't have a profile for, bump `rosterVersion` to refetch
  // — once per unknown id (`requestedUnknownRef`) so a 12 Hz cursor stream
  // doesn't spam the endpoint.
  const [rosterVersion, setRosterVersion] = useState(0);
  const membersRef = useRef<Map<string, CollaboratorProfile>>(members);
  membersRef.current = members;
  const requestedUnknownRef = useRef<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<TripSuggestion[]>([]);
  // When the shared list is fed into the modal via props, a silent
  // fetch failure here would leave `suggestions` empty and the modal
  // would render its "No suggestions yet" empty-state — indistinguish-
  // able from a real empty list and hiding auth/network/server errors.
  // Expose the failure so consumers can surface it as an alert.
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const lastEmitRef = useRef(0);

  // Capture callbacks in a ref so re-renders that pass a fresh
  // function identity don't tear down and re-establish socket
  // subscriptions on every keystroke in the planner.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const previousTripIdRef = useRef<string | null>(serverTripId);
  useEffect(() => {
    if (previousTripIdRef.current === serverTripId) return;
    previousTripIdRef.current = serverTripId;
    setCursors(new Map());
    setPresence(new Map());
    setMembers(new Map());
    requestedUnknownRef.current = new Set();
    setSuggestions([]);
    setSuggestionsError(null);
  }, [serverTripId]);

  useEffect(() => {
    if (!serverTripId) return;
    subscribeTrip(serverTripId);
    return () => unsubscribeTrip(serverTripId);
  }, [serverTripId]);

  useEffect(() => {
    if (!serverTripId) return;
    const noteUnknownUser = (userId: string) => {
      if (
        !membersRef.current.has(userId) &&
        !requestedUnknownRef.current.has(userId)
      ) {
        requestedUnknownRef.current.add(userId);
        setRosterVersion((v) => v + 1);
      }
    };
    const offCursor = onTripCursor((evt: TripCursorEvent) => {
      if (evt.trip_id !== serverTripId) return;
      noteUnknownUser(evt.user_id);
      setCursors((prev) => {
        const next = new Map(prev);
        next.set(evt.user_id, {
          userId: evt.user_id,
          lat: evt.lat,
          lng: evt.lng,
          lastSeenAt: Date.now(),
        });
        return next;
      });
    });
    const offPresence = onTripPresence((evt: TripPresenceEvent) => {
      if (evt.trip_id !== serverTripId) return;
      noteUnknownUser(evt.user_id);
      setPresence((prev) => {
        const next = new Map(prev);
        // Track sockets per user so multi-tab / multi-device members
        // don't get flagged offline when just one of their sockets
        // disconnects. Presence events are per-socket, not per-user.
        const existing = prev.get(evt.user_id);
        const socketDelta = evt.online ? 1 : -1;
        const nextSockets = Math.max(0, (existing?.sockets ?? 0) + socketDelta);
        next.set(evt.user_id, {
          userId: evt.user_id,
          online: nextSockets > 0,
          sockets: nextSockets,
          lastSeenAt: Date.now(),
        });
        return next;
      });
      // Let the TTL sweep drop cursors instead of reacting to every
      // "offline" event — a user with two tabs closing one shouldn't
      // make their cursor flap on other collaborators' maps. If the
      // other sockets keep emitting cursor updates the lastSeenAt will
      // stay fresh; if they don't, the sweep cleans up within
      // CURSOR_TTL_MS.
    });
    const offCreated = onTripSuggestionCreated((payload) => {
      const s = payload as TripSuggestion;
      if (s.trip_id !== serverTripId) return;
      setSuggestions((prev) => {
        // Dedupe by id — if the REST response already prepended the row
        // before the broadcast lands, replace in place instead of
        // producing a double-card flicker.
        const exists = prev.some((x) => x.id === s.id);
        if (exists) return prev.map((x) => (x.id === s.id ? s : x));
        return [s, ...prev];
      });
    });
    const offDeleted = onTripSuggestionDeleted((payload) => {
      const { suggestion_id } = payload as { suggestion_id: string };
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestion_id));
    });
    const offVoted = onTripSuggestionVoted((evt: TripSuggestionVotedEvent) => {
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === evt.suggestion_id
            ? {
                ...s,
                up_votes: evt.up_votes,
                down_votes: evt.down_votes,
              }
            : s,
        ),
      );
    });
    const offResolved = onTripSuggestionResolved(
      (evt: TripSuggestionResolvedEvent) => {
        setSuggestions((prev) =>
          prev.map((s) =>
            s.id === evt.suggestion_id ? { ...s, status: evt.status } : s,
          ),
        );
      },
    );
    // US-35 — fan out remote trip mutations to the planner page so
    // another rider regenerating or importing routes gets reflected
    // without a manual reload. Filter by `serverTripId` so a stale
    // event from a previously-joined room (e.g. after a fast trip
    // switch) doesn't clobber the new trip's state.
    const offUpdated = onTripUpdated((payload) => {
      const detail = payload as { id?: unknown };
      if (typeof detail?.id !== "string" || detail.id !== serverTripId) return;
      callbacksRef.current.onTripUpdated?.(payload);
    });
    const offTripDeleted = onTripDeleted((evt) => {
      if (evt.trip_id !== serverTripId) return;
      callbacksRef.current.onTripDeleted?.(evt);
    });
    return () => {
      offCursor();
      offPresence();
      offCreated();
      offDeleted();
      offVoted();
      offResolved();
      offUpdated();
      offTripDeleted();
    };
  }, [serverTripId]);

  // Gate the fetch on the auth token being hydrated. On a cold deep-link
  // load (`/trips/planner?tripId=…` — exactly how invited riders arrive)
  // this effect used to race `AuthSync`'s session hydration: it fired
  // without a bearer, got a 401, and the modal's Suggestions tab rendered
  // a permanent "Unauthorized" alert. `apiFetch` has no 401-retry (unlike
  // the typed client), so key on token *presence* — the fetch starts (or
  // re-runs) the moment the session lands, and token rotations don't
  // refetch because the boolean doesn't change.
  const hasAuthToken = useAuthStore((s) => s.accessToken !== null);
  useEffect(() => {
    if (!serverTripId || !hasAuthToken) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await tripCollabApi.listSuggestions(serverTripId);
        if (cancelled) return;
        setSuggestions(data);
        setSuggestionsError(null);
      } catch (err) {
        if (cancelled) return;
        setSuggestionsError(
          getUserFacingErrorMessage(err, t("Failed to load suggestions")),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, serverTripId, hasAuthToken]);

  // Roster for the map's cursor avatars — one lookup of user id → name +
  // avatar. Non-fatal on failure: a cursor without a profile falls back to a
  // plain marker. `listMembers` returns the joined roster to any member, so
  // viewers get names/avatars too (only pending invites are owner/editor-only).
  useEffect(() => {
    if (!serverTripId || !hasAuthToken) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await tripCollabApi.listMembers(serverTripId);
        if (cancelled) return;
        const next = new Map<string, CollaboratorProfile>();
        for (const m of data.members) {
          next.set(m.user_id, {
            userId: m.user_id,
            displayName: m.display_name,
            avatarUrl: m.avatar_url,
          });
        }
        setMembers(next);
      } catch {
        // Leave `members` empty; cursors render without a name/avatar.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `rosterVersion` re-runs this when a cursor/presence event surfaces a
    // collaborator who joined after the initial snapshot.
  }, [serverTripId, hasAuthToken, rosterVersion]);

  useEffect(() => {
    if (!serverTripId) return;
    const id = window.setInterval(() => {
      const cutoff = Date.now() - CURSOR_TTL_MS;
      setCursors((prev) => {
        let mutated = false;
        const next = new Map(prev);
        for (const [key, value] of prev) {
          if (value.lastSeenAt < cutoff) {
            next.delete(key);
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
    }, CURSOR_SWEEP_MS);
    return () => window.clearInterval(id);
  }, [serverTripId]);

  const emitCursor = useCallback(
    (lat: number, lng: number) => {
      if (!serverTripId) return;
      const now = Date.now();
      if (now - lastEmitRef.current < CURSOR_EMIT_THROTTLE_MS) return;
      lastEmitRef.current = now;
      emitTripCursorSocket(serverTripId, lat, lng);
    },
    [serverTripId],
  );

  return {
    cursors,
    presence,
    /** Trip roster keyed by user id — display name + avatar for cursor markers. */
    members,
    suggestions,
    setSuggestions,
    /** Last `listSuggestions` error, or null when the fetch succeeded. */
    suggestionsError,
    emitCursor,
  };
}
