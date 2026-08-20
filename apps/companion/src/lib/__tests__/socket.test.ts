import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";

type SocketHandler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  /** Mirrors socket.io's `socket.active` flag — true while auto-reconnect is pending. */
  active: boolean;
  auth: { token: string } | undefined;
  handlers: Map<string, SocketHandler[]>;
  emitted: Array<{ event: string; data: unknown }>;
  disconnected: boolean;
  allListenersRemoved: boolean;
  on: (event: string, cb: SocketHandler) => FakeSocket;
  off: (event: string, cb: SocketHandler) => FakeSocket;
  emit: (event: string, data?: unknown) => FakeSocket;
  disconnect: () => void;
  removeAllListeners: () => void;
  /** Test helper: fire a handler registered via `.on(event, …)`. */
  trigger: (event: string, ...args: unknown[]) => void;
}

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketHandler[]>();
  const emitted: Array<{ event: string; data: unknown }> = [];

  const fake: FakeSocket = {
    connected: false,
    active: true,
    auth: undefined,
    handlers,
    emitted,
    disconnected: false,
    allListenersRemoved: false,
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return fake;
    },
    off(event, cb) {
      const list = (handlers.get(event) ?? []).filter((h) => h !== cb);
      handlers.set(event, list);
      return fake;
    },
    emit(event, data) {
      emitted.push({ event, data });
      return fake;
    },
    disconnect() {
      fake.disconnected = true;
      fake.connected = false;
      fake.active = false;
      fake.trigger("disconnect", "io client disconnect");
    },
    removeAllListeners() {
      fake.allListenersRemoved = true;
      handlers.clear();
    },
    trigger(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
  };

  return fake;
}

// Shared fake between io() calls so each test can inspect the connection it
// triggered. Replaced in beforeEach.
let fake: FakeSocket;
const ioMock = vi.fn(
  (_url: string, opts?: { auth?: { token: string } }): FakeSocket => {
    fake.auth = opts?.auth;
    return fake;
  },
);

vi.mock("socket.io-client", () => ({
  io: (url: string, opts?: { auth?: { token: string } }) => ioMock(url, opts),
}));

async function loadSocket() {
  const socketModule = await import("../socket");
  return {
    ...socketModule,
    connectSocket: (token: string | null) =>
      socketModule.connectSocket(token, t),
  };
}

describe("lib/socket", () => {
  beforeEach(() => {
    fake = createFakeSocket();
    ioMock.mockClear();
  });

  afterEach(async () => {
    const { __resetSocketForTests } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");
    __resetSocketForTests();
    useRealtimeStore.getState().reset();
    vi.resetModules();
  });

  it("connects to the /events namespace with auth token and flips status to connected", async () => {
    const { connectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket("jwt-abc");
    expect(ioMock).toHaveBeenCalledTimes(1);
    const url = ioMock.mock.calls[0]![0];
    expect(url).toMatch(/\/events$/);
    expect(fake.auth).toEqual({ token: "jwt-abc" });
    expect(useRealtimeStore.getState().status).toBe("connecting");

    fake.trigger("connect");
    expect(useRealtimeStore.getState().status).toBe("connected");
    expect(useRealtimeStore.getState().lastError).toBeNull();
    expect(useRealtimeStore.getState().connectedAt).not.toBeNull();
  });

  it("reuses the existing socket when the token is unchanged", async () => {
    const { connectSocket } = await loadSocket();
    const first = connectSocket("token-1");
    const second = connectSocket("token-1");
    expect(first).toBe(second);
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects with the new token on token change", async () => {
    const { connectSocket } = await loadSocket();

    connectSocket("token-1");
    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");

    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(secondFake.auth).toEqual({ token: "token-2" });
  });

  it("stays in 'connecting' during reconnect attempts (active=true)", async () => {
    const { connectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    fake.trigger("connect");
    expect(useRealtimeStore.getState().status).toBe("connected");

    // Socket dropped but auto-reconnect still pending.
    fake.active = true;
    fake.trigger("disconnect", "transport close");
    expect(useRealtimeStore.getState().status).toBe("connecting");

    // Each failed reconnect fires connect_error; status must stay "connecting".
    fake.trigger("connect_error", new Error("ECONNREFUSED"));
    expect(useRealtimeStore.getState().status).toBe("connecting");
    expect(useRealtimeStore.getState().lastError).toBe(
      "Check your connection and try again.",
    );
  });

  it("transitions to 'disconnected' when the server denies the connection (active=false)", async () => {
    const { connectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    fake.active = false;
    fake.trigger("connect_error", new Error("auth failed"));

    expect(useRealtimeStore.getState().status).toBe("disconnected");
    expect(useRealtimeStore.getState().lastError).toBe(
      "Check your connection and try again.",
    );
  });

  it("does not set lastError when the disconnect was client-initiated", async () => {
    const { connectSocket, disconnectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    fake.trigger("connect");
    disconnectSocket();

    expect(useRealtimeStore.getState().status).toBe("disconnected");
    expect(useRealtimeStore.getState().lastError).toBeNull();
  });

  it("subscribeHazards emits the correct event payload", async () => {
    const { connectSocket, subscribeHazards } = await loadSocket();
    connectSocket(null);
    subscribeHazards(49.82, 18.26, 5000);

    expect(fake.emitted).toContainEqual({
      event: "subscribe:hazards",
      data: { lat: 49.82, lng: 18.26, radius_m: 5000 },
    });
  });

  it("unsubscribeHazards emits the leave event (and is a safe no-op with no socket)", async () => {
    const { connectSocket, unsubscribeHazards } = await loadSocket();

    // Before any connection: nothing to leave, nothing thrown.
    unsubscribeHazards();

    connectSocket(null);
    unsubscribeHazards();

    expect(fake.emitted).toContainEqual({
      event: "unsubscribe:hazards",
      data: undefined,
    });
    expect(
      fake.emitted.filter((e) => e.event === "unsubscribe:hazards"),
    ).toHaveLength(1);
  });

  it("onHazardNew invokes the callback for hazard:new events and unsubscribes cleanly", async () => {
    const { connectSocket, onHazardNew } = await loadSocket();
    connectSocket(null);

    const received: unknown[] = [];
    const unsubscribe = onHazardNew((h) => received.push(h));

    fake.trigger("hazard:new", { id: "h-1", hazard_type: "pothole" });
    expect(received).toHaveLength(1);

    unsubscribe();
    fake.trigger("hazard:new", { id: "h-2", hazard_type: "gravel" });
    expect(received).toHaveLength(1);
  });

  it("re-attaches persistent listeners when the socket is recreated on token change", async () => {
    const { connectSocket, onHazardNew } = await loadSocket();

    connectSocket("token-1");
    const received: unknown[] = [];
    onHazardNew((h) => received.push(h));

    // Token changes — new socket instance — listener must survive.
    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");

    secondFake.trigger("hazard:new", { id: "h-after-reauth" });
    expect(received).toEqual([{ id: "h-after-reauth" }]);
  });

  it("clears lastError on intentional (re)connect so stale errors don't persist", async () => {
    const { connectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    useRealtimeStore.getState().setError("auth failed");
    connectSocket("fresh-token");

    expect(useRealtimeStore.getState().lastError).toBeNull();
  });

  it("clears lastError on explicit disconnectSocket", async () => {
    const { connectSocket, disconnectSocket } = await loadSocket();
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    useRealtimeStore.getState().setError("network blip");
    disconnectSocket();

    expect(useRealtimeStore.getState().lastError).toBeNull();
  });

  it("unsubscribe detaches from the current socket after a reconnect", async () => {
    const { connectSocket, onHazardNew } = await loadSocket();

    connectSocket("token-1");
    const received: unknown[] = [];
    const unsubscribe = onHazardNew((h) => received.push(h));

    // Socket is replaced (token change). Handler is re-attached to the new socket.
    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");

    // Unsubscribe must target the *new* socket where the handler actually lives.
    unsubscribe();
    secondFake.trigger("hazard:new", { id: "should-not-fire" });
    expect(received).toHaveLength(0);
  });

  it("disconnectSocket detaches persistent listeners from the old socket", async () => {
    const { connectSocket, onHazardNew, disconnectSocket } = await loadSocket();

    connectSocket(null);
    const received: unknown[] = [];
    onHazardNew((h) => received.push(h));
    disconnectSocket();

    // The old socket reference still exists in the test; firing events on it
    // must not reach the consumer (handler was explicitly .off'd).
    fake.trigger("hazard:new", { id: "stale" });
    expect(received).toHaveLength(0);
  });

  // ── US-35 collab helpers ──

  it("subscribeTrip / unsubscribeTrip emit the expected payloads", async () => {
    const { connectSocket, subscribeTrip, unsubscribeTrip } =
      await loadSocket();
    connectSocket("token-1");

    subscribeTrip("trip-99");
    unsubscribeTrip("trip-99");

    expect(fake.emitted).toContainEqual({
      event: "subscribe:trip",
      data: { trip_id: "trip-99" },
    });
    expect(fake.emitted).toContainEqual({
      event: "unsubscribe:trip",
      data: { trip_id: "trip-99" },
    });
  });

  it("emitTripCursor sends the cursor payload", async () => {
    const { connectSocket, emitTripCursor } = await loadSocket();
    connectSocket(null);
    emitTripCursor("trip-99", 49.1, 16.75);

    expect(fake.emitted).toContainEqual({
      event: "trip:cursor",
      data: { trip_id: "trip-99", lat: 49.1, lng: 16.75 },
    });
  });

  it("onTripCursor / onTripPresence / onTripSuggestion* / onTripActivity dispatch payloads", async () => {
    const {
      connectSocket,
      onTripCursor,
      onTripPresence,
      onTripSuggestionCreated,
      onTripSuggestionDeleted,
      onTripSuggestionVoted,
      onTripSuggestionResolved,
      onTripActivity,
    } = await loadSocket();

    connectSocket(null);
    const seen: {
      cursor: unknown[];
      presence: unknown[];
      created: unknown[];
      deleted: unknown[];
      voted: unknown[];
      resolved: unknown[];
      activity: unknown[];
    } = {
      cursor: [],
      presence: [],
      created: [],
      deleted: [],
      voted: [],
      resolved: [],
      activity: [],
    };
    onTripCursor((e) => seen.cursor.push(e));
    onTripPresence((e) => seen.presence.push(e));
    onTripSuggestionCreated((e) => seen.created.push(e));
    onTripSuggestionDeleted((e) => seen.deleted.push(e));
    onTripSuggestionVoted((e) => seen.voted.push(e));
    onTripSuggestionResolved((e) => seen.resolved.push(e));
    onTripActivity((e) => seen.activity.push(e));

    fake.trigger("trip:cursor", { user_id: "u-1" });
    fake.trigger("trip:presence", { user_id: "u-1", online: true });
    fake.trigger("trip:suggestion:created", { id: "s-1" });
    fake.trigger("trip:suggestion:deleted", { suggestion_id: "s-1" });
    fake.trigger("trip:suggestion:voted", {
      suggestion_id: "s-1",
      up_votes: 1,
      down_votes: 0,
    });
    fake.trigger("trip:suggestion:resolved", {
      suggestion_id: "s-1",
      status: "accepted",
    });
    fake.trigger("trip:activity", { id: "a-1" });

    expect(seen.cursor).toHaveLength(1);
    expect(seen.presence).toHaveLength(1);
    expect(seen.created).toHaveLength(1);
    expect(seen.deleted).toHaveLength(1);
    expect(seen.voted).toHaveLength(1);
    expect(seen.resolved).toHaveLength(1);
    expect(seen.activity).toHaveLength(1);
  });

  it("trip listeners survive a token-change reconnect", async () => {
    const { connectSocket, onTripSuggestionCreated } = await loadSocket();

    connectSocket("token-1");
    const seen: unknown[] = [];
    onTripSuggestionCreated((payload) => seen.push(payload));

    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");

    secondFake.trigger("trip:suggestion:created", { id: "s-after-reauth" });
    expect(seen).toEqual([{ id: "s-after-reauth" }]);
  });

  it("replays trip-room subscriptions on a transport-level reconnect", async () => {
    const { connectSocket, subscribeTrip } = await loadSocket();

    connectSocket("token-1");
    fake.trigger("connect"); // initial connect
    subscribeTrip("trip-123");

    // Socket drops and reconnects at the transport layer — same socket
    // instance, just a new `connect` event. Backend room membership
    // is gone; the client must replay `subscribe:trip`.
    fake.emitted.length = 0;
    fake.trigger("connect");

    expect(fake.emitted).toContainEqual({
      event: "subscribe:trip",
      data: { trip_id: "trip-123" },
    });
  });

  it("replays trip-room subscriptions across a token-change socket replacement", async () => {
    const { connectSocket, subscribeTrip } = await loadSocket();

    connectSocket("token-1");
    subscribeTrip("trip-abc");

    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");
    secondFake.trigger("connect");

    expect(secondFake.emitted).toContainEqual({
      event: "subscribe:trip",
      data: { trip_id: "trip-abc" },
    });
  });

  it("does not replay trip subscriptions after an explicit unsubscribeTrip", async () => {
    const { connectSocket, subscribeTrip, unsubscribeTrip } =
      await loadSocket();

    connectSocket("token-1");
    subscribeTrip("trip-x");
    unsubscribeTrip("trip-x");

    fake.emitted.length = 0;
    fake.trigger("connect");

    expect(
      fake.emitted.some(
        (e) =>
          e.event === "subscribe:trip" &&
          (e.data as { trip_id: string }).trip_id === "trip-x",
      ),
    ).toBe(false);
  });

  it("preserves trip subscriptions across RealtimeProvider's disconnect+connect on token change", async () => {
    // RealtimeProvider's effect cleanup calls disconnectSocket() on
    // every token change, then the next render calls
    // connectSocket(newToken). This flow must not silently drop trip
    // memberships — otherwise `useTripCollabSession` only ever
    // re-subscribes on `serverTripId` change, which doesn't fire
    // during a token refresh.
    const { connectSocket, disconnectSocket, subscribeTrip } =
      await loadSocket();

    connectSocket("token-1");
    subscribeTrip("trip-keep-me");

    // Simulate RealtimeProvider's token-refresh lifecycle.
    disconnectSocket();
    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");
    secondFake.trigger("connect");

    expect(secondFake.emitted).toContainEqual({
      event: "subscribe:trip",
      data: { trip_id: "trip-keep-me" },
    });
  });
});
