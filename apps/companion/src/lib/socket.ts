import { io, type Socket } from "socket.io-client";
import { API_HOST } from "@/lib/config";
import { useRealtimeStore } from "@/stores/realtime";
import type { HazardResponse } from "@/lib/api";
import type { Translate } from "@/i18n";

/**
 * Socket.io client bound to the backend `/events` namespace (see
 * `EventsGateway` in the backend). One shared connection per tab; consumers
 * subscribe via the typed helpers below.
 *
 * Connection lifecycle is mirrored into `useRealtimeStore` so UI components
 * (e.g. the sidebar's offline chip) can react without importing this module directly.
 *
 * Listeners registered via the `on*` helpers are tracked module-side and
 * re-attached automatically if the underlying socket is replaced (e.g. on
 * auth-token change). Consumers don't need to re-subscribe themselves.
 */

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || API_HOST || "";
const NAMESPACE = "/events";

type SocketListener = (...args: unknown[]) => void;
interface PersistentListener {
  event: string;
  handler: SocketListener;
  /** Socket the handler is currently attached to — `null` while disconnected. */
  socket: Socket | null;
}

let socket: Socket | null = null;
let currentToken: string | null = null;
const persistentListeners = new Set<PersistentListener>();
/**
 * Trip ids the caller is currently subscribed to. Tracked here so a
 * socket replacement (token change) or a transport-level reconnect can
 * replay `subscribe:trip` without the consumer having to observe the
 * `connect` event themselves. Membership-checked server-side on every
 * join — we emit aggressively and let the gateway reject if the user
 * lost access between sessions.
 */
const subscribedTripIds = new Set<string>();

/**
 * Hazard payload emitted by the backend on `hazard:new`. Either a real hazard
 * (a `HazardResponse`) or a moderation-removal sentinel — `severity: "dismissed"`
 * retracts a marker and is NOT one of the REST `HazardResponse` severities.
 * Modelled as a discriminated union so `applyHazardWsEvent` narrows on
 * `severity === "dismissed"` and treats the other case as a plain hazard.
 */
export type HazardDismissedEvent = Omit<HazardResponse, "severity"> & {
  severity: "dismissed";
};
export type HazardNewEvent = HazardResponse | HazardDismissedEvent;

export function connectSocket(token: string | null, t: Translate): Socket {
  if (socket) {
    if (currentToken === token) return socket;
    // Token changed (login / logout / refresh) — reconnect with new
    // auth. `disconnectSocketInternal` preserves the trip-room
    // membership set so the `connect` handler below can replay them
    // on the new socket.
    disconnectSocketInternal();
  }

  currentToken = token;
  const { setStatus, setError } = useRealtimeStore.getState();
  // Intentional transition — clear any stale error from a prior session so
  // the UI doesn't show e.g. "auth failed" while we're actively reconnecting.
  setError(null);
  setStatus("connecting");

  const url = WS_URL ? `${WS_URL}${NAMESPACE}` : NAMESPACE;
  const next = io(url, {
    ...(token ? { auth: { token } } : {}),
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    autoConnect: true,
  });

  next.on("connect", () => {
    setStatus("connected");
    setError(null);
    // Transport-level reconnect: room memberships live on the backend
    // socket, which just got replaced. Replay the trip-room joins so
    // `trip:cursor`, `trip:presence`, `trip:suggestion`, and
    // `trip:activity` keep flowing without a page reload.
    for (const tripId of subscribedTripIds) {
      next.emit("subscribe:trip", { trip_id: tripId });
    }
  });

  // socket.active is true as long as socket.io will auto-reconnect — this
  // avoids a status flip to "disconnected" between each failed attempt, which
  // would make the sidebar offline chip flicker between "Offline" and
  // "Reconnecting…" on every transport hiccup.
  next.on("disconnect", (reason) => {
    setStatus(next.active ? "connecting" : "disconnected");
    // "io client disconnect" means we called disconnect() on purpose — not an error.
    if (reason !== "io client disconnect") {
      setError(t("Check your connection and try again."));
    }
  });

  next.on("connect_error", (err) => {
    setStatus(next.active ? "connecting" : "disconnected");
    console.warn("Realtime connection error:", err);
    setError(t("Check your connection and try again."));
  });

  // Re-attach any listeners consumers registered before this (re)connection,
  // and update each registration's socket pointer so unsubscribe targets the
  // exact socket the handler is attached to.
  for (const registration of persistentListeners) {
    next.on(registration.event, registration.handler);
    registration.socket = next;
  }

  socket = next;
  return next;
}

/**
 * Close the underlying socket without clearing trip-room memberships.
 * `subscribedTripIds` is owned by consumers (they add via
 * `subscribeTrip` and remove via `unsubscribeTrip` on their own
 * lifecycle); wiping it here broke token-refresh flows because the
 * `RealtimeProvider` effect calls this on every token change, and
 * `useTripCollabSession` only re-subscribes when `serverTripId`
 * changes. Preserving the set lets the new socket's `connect` handler
 * replay joins so live updates keep flowing after a refresh.
 */
export function disconnectSocket(): void {
  disconnectSocketInternal();
}

function disconnectSocketInternal(): void {
  if (!socket) return;
  for (const registration of persistentListeners) {
    registration.socket?.off(registration.event, registration.handler);
    registration.socket = null;
  }
  socket.disconnect();
  socket = null;
  currentToken = null;
  const { setStatus, setError } = useRealtimeStore.getState();
  setStatus("disconnected");
  setError(null);
}

// ── Persistent-listener registration helper ──

/**
 * Register a listener that's automatically re-attached to a new socket
 * after a token-change reconnect, and cleanly detached on unsubscribe
 * from whichever socket the handler is currently on (which may not be
 * the original one if `connectSocket` ran a replacement in between).
 */
function registerPersistent<TPayload>(
  event: string,
  cb: (payload: TPayload) => void,
): () => void {
  const handler: SocketListener = (payload) => cb(payload as TPayload);
  const registration: PersistentListener = {
    event,
    handler,
    socket,
  };
  persistentListeners.add(registration);
  socket?.on(event, handler);
  return () => {
    persistentListeners.delete(registration);
    registration.socket?.off(registration.event, handler);
    registration.socket = null;
  };
}

// ── Hazard alerts ──

/**
 * Subscribe to new hazard alerts within the grid cell(s) covering a point.
 * Replaces any previous hazard subscription on the same socket.
 */
export function subscribeHazards(
  lat: number,
  lng: number,
  radiusMeters?: number,
): void {
  socket?.emit("subscribe:hazards", { lat, lng, radius_m: radiusMeters });
}

/**
 * Leave every hazard room on the server. The gateway only sweeps a socket's
 * stale hazard rooms on its NEXT `subscribe:hazards` (or on disconnect), so a
 * consumer that stops showing hazards without ever resubscribing — the rider
 * toggles them off, or the `hazard_alerts` kill switch flips — must emit this
 * or the server keeps fanning `hazard:new` events out to a client that
 * ignores them (#1160). Safe no-op with no socket; while a reconnect is
 * pending the emit is buffered and, delivered onto the fresh (room-less)
 * server socket, leaves nothing.
 */
export function unsubscribeHazards(): void {
  socket?.emit("unsubscribe:hazards");
}

/**
 * Listen for `hazard:new` broadcasts. Returns an unsubscribe function. The
 * listener is re-attached automatically if the socket is recreated.
 */
export function onHazardNew(cb: (hazard: HazardNewEvent) => void): () => void {
  return registerPersistent<HazardNewEvent>("hazard:new", cb);
}

// ── Trip collaboration (US-35) ──

/**
 * Payloads mirror the backend DTOs (`TripCursorPayload`,
 * `TripPresencePayload`, `SuggestionResponseDto`, `TripActivityEntryDto`).
 * Kept local to avoid reaching into @tarmoto/openapi-client for socket-only types.
 */
export interface TripCursorEvent {
  user_id: string;
  trip_id: string;
  lat: number;
  lng: number;
  at: string;
}

export interface TripPresenceEvent {
  trip_id: string;
  user_id: string;
  online: boolean;
  at: string;
}

/**
 * Join the live room for a trip so collab events start flowing. The
 * trip id is remembered so we can rejoin automatically after a
 * transport-level reconnect or a token-change socket replacement.
 */
export function subscribeTrip(tripId: string): void {
  subscribedTripIds.add(tripId);
  socket?.emit("subscribe:trip", { trip_id: tripId });
}

/** Leave the live room and broadcast an offline presence event. */
export function unsubscribeTrip(tripId: string): void {
  subscribedTripIds.delete(tripId);
  socket?.emit("unsubscribe:trip", { trip_id: tripId });
}

/**
 * Broadcast the caller's cursor to other collaborators in the trip room.
 * Callers should throttle (e.g. via requestAnimationFrame or lodash.throttle)
 * to keep event volume bounded — the gateway doesn't rate-limit cursors.
 */
export function emitTripCursor(tripId: string, lat: number, lng: number): void {
  socket?.emit("trip:cursor", { trip_id: tripId, lat, lng });
}

/** Listen for other collaborators' cursor positions. */
export function onTripCursor(cb: (evt: TripCursorEvent) => void): () => void {
  return registerPersistent<TripCursorEvent>("trip:cursor", cb);
}

/** Listen for online/offline presence transitions in the trip room. */
export function onTripPresence(
  cb: (evt: TripPresenceEvent) => void,
): () => void {
  return registerPersistent<TripPresenceEvent>("trip:presence", cb);
}

/**
 * Wire shape of `trip:suggestion:voted`. The backend broadcasts just the
 * updated tally (not the full suggestion) so clients reconcile against
 * their local copy — this keeps payload size bounded on every vote and
 * avoids leaking an actor-scoped `caller_vote` to other recipients.
 */
export interface TripSuggestionVotedEvent {
  suggestion_id: string;
  up_votes: number;
  down_votes: number;
}

/**
 * Wire shape of `trip:suggestion:resolved` — status flip on
 * accept/reject, or back to `open` when the owner reopens.
 */
export interface TripSuggestionResolvedEvent {
  suggestion_id: string;
  status: "accepted" | "rejected" | "open";
}

/**
 * Listen for a newly-created suggestion broadcast. The payload mirrors
 * the REST `TripSuggestion` shape so consumers can reuse the same
 * reducer for both HTTP responses and live updates.
 */
export function onTripSuggestionCreated(
  cb: (payload: unknown) => void,
): () => void {
  return registerPersistent<unknown>("trip:suggestion:created", cb);
}

/** Listen for suggestion deletions. Payload: `{ suggestion_id }`. */
export function onTripSuggestionDeleted(
  cb: (payload: unknown) => void,
): () => void {
  return registerPersistent<unknown>("trip:suggestion:deleted", cb);
}

/** Listen for vote tally updates. */
export function onTripSuggestionVoted(
  cb: (evt: TripSuggestionVotedEvent) => void,
): () => void {
  return registerPersistent<TripSuggestionVotedEvent>(
    "trip:suggestion:voted",
    cb,
  );
}

/** Listen for owner accept/reject resolution. */
export function onTripSuggestionResolved(
  cb: (evt: TripSuggestionResolvedEvent) => void,
): () => void {
  return registerPersistent<TripSuggestionResolvedEvent>(
    "trip:suggestion:resolved",
    cb,
  );
}

/** Listen for new activity-log entries on the trip. */
export function onTripActivity(cb: (payload: unknown) => void): () => void {
  return registerPersistent<unknown>("trip:activity", cb);
}

/**
 * Listen for `trip:updated` broadcasts emitted whenever a collaborator
 * regenerates, imports, replaces, or otherwise mutates the trip via
 * the REST API. The payload mirrors `TripDetailDto` so consumers can
 * re-hydrate the local planner state without a follow-up REST fetch.
 *
 * Typed as `unknown` because socket.ts intentionally avoids reaching
 * into the OpenAPI-generated types — consumers cast to whatever shape
 * they expect (the planner page uses `TripDetailResponse`).
 */
export function onTripUpdated(cb: (payload: unknown) => void): () => void {
  return registerPersistent<unknown>("trip:updated", cb);
}

/**
 * Listen for `trip:deleted` broadcasts emitted when the owner deletes
 * the trip. Consumers should drop their local trip state and navigate
 * away — the room is about to be torn down.
 */
export interface TripDeletedEvent {
  trip_id: string;
}
export function onTripDeleted(cb: (evt: TripDeletedEvent) => void): () => void {
  return registerPersistent<TripDeletedEvent>("trip:deleted", cb);
}

// ── Testing hook — reset module state between tests ──

/** @internal Test-only: clear the cached socket/token without touching the store. */
export function __resetSocketForTests(): void {
  socket = null;
  currentToken = null;
  persistentListeners.clear();
  subscribedTripIds.clear();
}
