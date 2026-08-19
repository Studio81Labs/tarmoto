/**
 * #341 — socket.io client for the `hazard:new` fan-out.
 *
 * Owns a single connection to the backend `/events` namespace, joins
 * the gateway's `subscribe:hazards` cells around the rider's current
 * map centre, and dispatches every incoming `hazard:new` event to a
 * handler the screen registers on mount.
 *
 * Lifecycle is tied to AppState rather than screen mount: a rider who
 * tabs out of Map but stays inside the app keeps the connection so
 * hazards reported while they're elsewhere still land instantly when
 * they return. Going background (or inactive) tears the socket down so
 * we don't burn cellular bandwidth on a screen the rider can't see;
 * `connect` replays the latest `subscribe:hazards` automatically so
 * reconnects (foreground OR socket.io's own retry after a network
 * drop) re-join the right cells without the screen having to manage
 * it.
 */
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
} from "react-native";
import { io, type Socket } from "socket.io-client";
// Reads the in-memory token mirror (#1231) — the socket auth callback runs
// at every (re)connect, long after the cold-start hydration.
import { getAccessToken } from "./typedClient";
import { resolveEventsUrl } from "./eventsSocketUrl";
import type { HazardAlertEvent } from "@/types";

/** Default radius the gateway uses to compute covering cells. */
const DEFAULT_SUBSCRIBE_RADIUS_M = 10000;

export interface HazardSubscription {
  lat: number;
  lng: number;
  /** Defaults to {@link DEFAULT_SUBSCRIBE_RADIUS_M} when omitted. */
  radius_m?: number;
}

export interface HazardSocketHandlers {
  onHazard: (event: HazardAlertEvent) => void;
  onError?: (message: string) => void;
}

class HazardSocketService {
  private socket: Socket | null = null;
  private handlers: HazardSocketHandlers | null = null;
  private subscription: HazardSubscription | null = null;
  private appStateSub: NativeEventSubscription | null = null;

  /**
   * Start tracking hazard alerts. Idempotent — re-calling rebinds the
   * handlers and updates the active subscription without churning the
   * connection. The screen owns calling {@link stop} on unmount.
   *
   * Connects immediately when AppState is `active`. When it isn't (e.g.
   * the screen mounted while the OS-resumed-but-not-yet-active state
   * was reported), the subscribed cells are deferred to the next
   * foreground transition rather than racing the OS lifecycle.
   */
  start(
    subscription: HazardSubscription,
    handlers: HazardSocketHandlers,
  ): void {
    this.handlers = handlers;
    this.subscription = subscription;

    if (!this.appStateSub) {
      this.appStateSub = AppState.addEventListener(
        "change",
        this.handleAppState,
      );
    }

    if (AppState.currentState === "active") {
      this.openConnection();
    }
  }

  /**
   * Update the active geographic subscription — typically called when
   * the rider settles a pan on the map. The gateway's `subscribe:hazards`
   * leaves any previously joined hazard rooms and re-joins the new
   * covering cells, so re-emitting on every settle is the intended
   * shape (no need to track a previous bbox client-side). No-op when
   * not yet connected; the next `connect` event will pick up the
   * updated subscription via the replay path.
   */
  updateSubscription(subscription: HazardSubscription): void {
    this.subscription = subscription;
    if (this.socket?.connected) {
      this.emitSubscribe();
    }
  }

  /**
   * Tear down the AppState listener and the socket. Called from the
   * screen on unmount so a stale connection doesn't survive past the
   * map being torn down.
   */
  stop(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.closeConnection();
    this.handlers = null;
    this.subscription = null;
  }

  /** Test-only — surface internal connection state for assertions. */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  private handleAppState = (state: AppStateStatus): void => {
    if (state === "active") {
      this.openConnection();
      return;
    }
    // `inactive` is a transient iOS state during interruptions (e.g.
    // pulling Control Center). Treat it the same as `background` —
    // dropping the socket here is fine because the next `active` will
    // re-open and replay the subscription, and the alternative (staying
    // connected through inactive) sometimes leaves the socket in a
    // half-dead state when the app is later force-closed.
    this.closeConnection();
  };

  private openConnection(): void {
    if (this.socket) return;
    if (!this.subscription) return;

    const socket = io(resolveEventsUrl(), {
      // Pass `auth` as a callback so socket.io re-reads the token on
      // every (re)connect. Mirrors `groupRideSocket` — the static
      // `{ token }` form would freeze the value at construction time
      // and miss tokens rotated by the axios refresh interceptor.
      // Hazards subscription itself is unauthenticated server-side, but
      // sending the token still lets the gateway authenticate the
      // socket so future targeted events (`emitToUser`) reach this
      // client without a reconnect.
      auth: (cb) => {
        const token = getAccessToken();
        cb(token ? { token } : {});
      },
      transports: ["websocket"],
      reconnection: true,
    });

    socket.on("connect", () => {
      // Replay subscribe on every (re)connect so a network drop +
      // socket.io reconnect doesn't silently leave us in cells we
      // expected to be in.
      if (this.subscription) {
        this.emitSubscribe();
      }
    });

    socket.on("hazard:new", (event: HazardAlertEvent) => {
      this.handlers?.onHazard(event);
    });

    socket.on("error", (msg: { message?: string } | undefined) => {
      this.handlers?.onError?.(msg?.message ?? "socket error");
    });

    this.socket = socket;
  }

  private closeConnection(): void {
    if (!this.socket) return;
    this.socket.disconnect();
    this.socket = null;
  }

  private emitSubscribe(): void {
    if (!this.socket || !this.subscription) return;
    this.socket.emit("subscribe:hazards", {
      lat: this.subscription.lat,
      lng: this.subscription.lng,
      radius_m: this.subscription.radius_m ?? DEFAULT_SUBSCRIBE_RADIUS_M,
    });
  }
}

export const hazardSocket = new HazardSocketService();

// Test-only — fresh instance escape hatch so unit tests can exercise
// the class without leaking module-level state across cases.
export const __HazardSocketServiceForTest = HazardSocketService;
