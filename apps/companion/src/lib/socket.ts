import { io, type Socket } from "socket.io-client";
import { API_HOST } from "@/lib/config";
import { useRealtimeStore } from "@/stores/realtime";
import type { HazardResponse } from "@/lib/api";

/**
 * Socket.io client bound to the backend `/events` namespace (see
 * `EventsGateway` in the backend). One shared connection per tab; consumers
 * subscribe via the typed helpers below.
 *
 * Connection lifecycle is mirrored into `useRealtimeStore` so UI components
 * (e.g. OfflineIndicator) can react without importing this module directly.
 */

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || API_HOST || "";
const NAMESPACE = "/events";

let socket: Socket | null = null;
let currentToken: string | null = null;

/** Hazard payload emitted by the backend on `hazard:new`. */
export type HazardNewEvent = HazardResponse;

export function connectSocket(token: string | null = null): Socket {
  if (socket) {
    if (currentToken === token) return socket;
    // Token changed (login / logout / refresh) — reconnect with new auth.
    disconnectSocket();
  }

  currentToken = token;
  const { setStatus, setError } = useRealtimeStore.getState();
  setStatus("connecting");

  const url = WS_URL ? `${WS_URL}${NAMESPACE}` : NAMESPACE;
  const next = io(url, {
    auth: token ? { token } : undefined,
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
  });

  // socket.active is true as long as socket.io will auto-reconnect — this
  // avoids a status flip to "disconnected" between each failed attempt, which
  // would make the OfflineIndicator flicker between "Offline" and
  // "Reconnecting…" on every transport hiccup.
  next.on("disconnect", (reason) => {
    setStatus(next.active ? "connecting" : "disconnected");
    // "io client disconnect" means we called disconnect() on purpose — not an error.
    if (reason !== "io client disconnect") {
      setError(reason);
    }
  });

  next.on("connect_error", (err) => {
    setStatus(next.active ? "connecting" : "disconnected");
    setError(err.message);
  });

  socket = next;
  return next;
}

export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  currentToken = null;
  useRealtimeStore.getState().setStatus("disconnected");
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
 * Listen for `hazard:new` broadcasts. Returns an unsubscribe function.
 */
export function onHazardNew(cb: (hazard: HazardNewEvent) => void): () => void {
  const handler = (payload: HazardNewEvent) => cb(payload);
  socket?.on("hazard:new", handler);
  return () => {
    socket?.off("hazard:new", handler);
  };
}

// ── Testing hook — reset module state between tests ──

/** @internal Test-only: clear the cached socket/token without touching the store. */
export function __resetSocketForTests(): void {
  socket = null;
  currentToken = null;
}
