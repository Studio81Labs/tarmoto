import { useCallback, useEffect, useRef, useState } from "react";
import { tripCollabApi, type TripSuggestion } from "@/lib/api";
import {
  emitTripCursor as emitTripCursorSocket,
  onTripCursor,
  onTripPresence,
  onTripSuggestionCreated,
  onTripSuggestionDeleted,
  onTripSuggestionResolved,
  onTripSuggestionVoted,
  subscribeTrip,
  unsubscribeTrip,
  type TripCursorEvent,
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

/** Online presence bookkeeping for the member list. */
export interface CollaboratorPresence {
  userId: string;
  online: boolean;
  lastSeenAt: number;
}

const CURSOR_TTL_MS = 10_000;
const CURSOR_EMIT_THROTTLE_MS = 150;
const CURSOR_SWEEP_MS = 2_000;

/**
 * Hook that wires the planner page to the live trip-collaboration surface.
 *
 * Once `serverTripId` is non-null, it:
 *   • joins the socket room `trip:<id>` (and leaves on unmount)
 *   • maintains maps of live cursors and presence
 *   • owns the shared `suggestions` list (map overlay + modal read from
 *     the same state, avoiding a double-fetch / double-listener pair)
 *   • exposes a throttled `emitCursor(lat, lng)` callback
 *
 * Broadcast payloads carry `caller_vote: null` (the backend can't know
 * each recipient's vote); the merge logic preserves the locally-known
 * `caller_vote` so another member's vote doesn't wipe the caller's own-
 * vote highlight.
 *
 * Switching trips resets cursors/presence/suggestions so cross-trip data
 * never leaks into the new session.
 */
export function useTripCollabSession(serverTripId: string | null) {
  const [cursors, setCursors] = useState<Map<string, CollaboratorCursor>>(
    () => new Map(),
  );
  const [presence, setPresence] = useState<Map<string, CollaboratorPresence>>(
    () => new Map(),
  );
  const [suggestions, setSuggestions] = useState<TripSuggestion[]>([]);
  const lastEmitRef = useRef(0);

  const previousTripIdRef = useRef<string | null>(serverTripId);
  useEffect(() => {
    if (previousTripIdRef.current === serverTripId) return;
    previousTripIdRef.current = serverTripId;
    setCursors(new Map());
    setPresence(new Map());
    setSuggestions([]);
  }, [serverTripId]);

  useEffect(() => {
    if (!serverTripId) return;
    subscribeTrip(serverTripId);
    return () => unsubscribeTrip(serverTripId);
  }, [serverTripId]);

  useEffect(() => {
    if (!serverTripId) return;
    const offCursor = onTripCursor((evt: TripCursorEvent) => {
      if (evt.trip_id !== serverTripId) return;
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
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(evt.user_id, {
          userId: evt.user_id,
          online: evt.online,
          lastSeenAt: Date.now(),
        });
        return next;
      });
      if (!evt.online) {
        // Drop their cursor immediately rather than waiting for the TTL
        // sweep — an "offline" signal is authoritative.
        setCursors((prev) => {
          if (!prev.has(evt.user_id)) return prev;
          const next = new Map(prev);
          next.delete(evt.user_id);
          return next;
        });
      }
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
    return () => {
      offCursor();
      offPresence();
      offCreated();
      offDeleted();
      offVoted();
      offResolved();
    };
  }, [serverTripId]);

  useEffect(() => {
    if (!serverTripId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await tripCollabApi.listSuggestions(serverTripId);
        if (cancelled) return;
        setSuggestions(data);
      } catch {
        // Non-fatal — the modal surfaces a concrete error if it also
        // fails its own action (e.g. submit, vote).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverTripId]);

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
    suggestions,
    setSuggestions,
    emitCursor,
  };
}
