/**
 * US-26 — socket.io client for live group ride position sharing.
 *
 * Owns a single connection to the backend `/events` namespace, joins
 * the `subscribe:group` room for the active ride, and dispatches
 * `group:position` / `group:joined` / `group:left` / `group:ended`
 * events to a handler the screen registers on mount.
 *
 * Position publishing is intentionally rate-limited to 1 Hz on the
 * client AND on the server — the client throttle saves bandwidth on
 * cellular, the server throttle is the trust boundary. Both must be in
 * place because either alone is bypassable.
 */
import { io, type Socket } from "socket.io-client";
// Reads the in-memory token mirror (#1231) — the socket auth callback runs
// at every (re)connect, long after the cold-start hydration.
import { getAccessToken } from "./typedClient";
import { resolveEventsUrl } from "./eventsSocketUrl";
import type {
  GroupEndedEvent,
  GroupJoinedEvent,
  GroupLeftEvent,
  GroupPositionEvent,
} from "@/types";

// Match the server-side `GROUP_POSITION_THROTTLE_MS` to avoid sending
// updates the gateway will only drop. A slightly looser client floor
// (e.g. 1100ms) would let one in eight ticks through, so we mirror the
// server value exactly and add a small jitter cushion below.
const POSITION_PUBLISH_INTERVAL_MS = 1000;

export interface GroupRideSocketHandlers {
  onPosition: (event: GroupPositionEvent) => void;
  onJoined: (event: GroupJoinedEvent) => void;
  onLeft: (event: GroupLeftEvent) => void;
  onEnded: (event: GroupEndedEvent) => void;
  onError?: (message: string) => void;
}

class GroupRideSocketService {
  private socket: Socket | null = null;
  private subscribedGroupRideId: string | null = null;
  private handlers: GroupRideSocketHandlers | null = null;
  private lastPublishMs = 0;

  /**
   * Connect (if needed) and subscribe to a group ride. Idempotent —
   * calling with the same id is a no-op so screen mounts/remounts
   * don't churn the connection.
   */
  connect(groupRideId: string, handlers: GroupRideSocketHandlers): void {
    this.handlers = handlers;
    if (this.socket && this.subscribedGroupRideId === groupRideId) return;

    if (!this.socket) {
      // Pass `auth` as a callback so socket.io re-reads the token on
      // every (re)connect attempt. The static `{ token }` form
      // captured the value at construction time, so a token rotated
      // by the axios refresh interceptor mid-session would never reach
      // the socket — the gateway would treat the reconnecting client
      // as anonymous and silently drop the `subscribe:group` replay.
      this.socket = io(resolveEventsUrl(), {
        auth: (cb) => {
          const token = getAccessToken();
          cb(token ? { token } : {});
        },
        transports: ["websocket"],
        // Auto-reconnect; on reconnect, replay the subscribe so we
        // re-join the room without forcing the screen to manage it.
        reconnection: true,
      });

      this.socket.on("connect", () => {
        if (this.subscribedGroupRideId) {
          this.socket?.emit("subscribe:group", {
            group_ride_id: this.subscribedGroupRideId,
          });
        }
      });

      this.socket.on("error", (msg: { message?: string }) => {
        this.handlers?.onError?.(msg?.message ?? "socket error");
      });

      this.socket.on("group:position", (event: GroupPositionEvent) => {
        this.handlers?.onPosition(event);
      });
      this.socket.on("group:joined", (event: GroupJoinedEvent) => {
        this.handlers?.onJoined(event);
      });
      this.socket.on("group:left", (event: GroupLeftEvent) => {
        this.handlers?.onLeft(event);
      });
      this.socket.on("group:ended", (event: GroupEndedEvent) => {
        this.handlers?.onEnded(event);
      });
    }

    if (
      this.subscribedGroupRideId &&
      this.subscribedGroupRideId !== groupRideId
    ) {
      this.socket.emit("unsubscribe:group", {
        group_ride_id: this.subscribedGroupRideId,
      });
    }
    this.subscribedGroupRideId = groupRideId;
    if (this.socket.connected) {
      this.socket.emit("subscribe:group", { group_ride_id: groupRideId });
    }
  }

  /**
   * Publish a position to the active group ride. Drops calls inside
   * the 1 Hz window so a tight location-update loop can call this on
   * every fix without overrunning the server-side throttle (and
   * burning client bandwidth).
   */
  publishPosition(position: {
    lat: number;
    lng: number;
    speed?: number;
    heading?: number;
  }): void {
    if (!this.socket || !this.subscribedGroupRideId) return;
    const now = Date.now();
    if (now - this.lastPublishMs < POSITION_PUBLISH_INTERVAL_MS) return;
    this.lastPublishMs = now;
    this.socket.emit("group:position", {
      group_ride_id: this.subscribedGroupRideId,
      lat: position.lat,
      lng: position.lng,
      speed: position.speed,
      heading: position.heading,
    });
  }

  /**
   * Tear down the connection and forget the active subscription.
   * Called from the screen on unmount AND from the leave/end flows so
   * a stale socket can't keep broadcasting after the rider has opted
   * out of sharing.
   */
  disconnect(): void {
    if (this.socket && this.subscribedGroupRideId) {
      this.socket.emit("unsubscribe:group", {
        group_ride_id: this.subscribedGroupRideId,
      });
    }
    this.socket?.disconnect();
    this.socket = null;
    this.subscribedGroupRideId = null;
    this.handlers = null;
    this.lastPublishMs = 0;
  }
}

export const groupRideSocket = new GroupRideSocketService();
