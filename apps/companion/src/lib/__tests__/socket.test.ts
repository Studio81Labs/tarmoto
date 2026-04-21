import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SocketHandler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  auth: { token: string } | undefined;
  handlers: Map<string, SocketHandler[]>;
  ioHandlers: Map<string, SocketHandler[]>;
  emitted: Array<{ event: string; data: unknown }>;
  disconnected: boolean;
  allListenersRemoved: boolean;
  on: (event: string, cb: SocketHandler) => FakeSocket;
  off: (event: string, cb: SocketHandler) => FakeSocket;
  emit: (event: string, data?: unknown) => FakeSocket;
  disconnect: () => void;
  removeAllListeners: () => void;
  io: { on: (event: string, cb: SocketHandler) => void };
  /** Test helper: fire a handler registered via `.on(event, …)`. */
  trigger: (event: string, ...args: unknown[]) => void;
  triggerIo: (event: string, ...args: unknown[]) => void;
}

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketHandler[]>();
  const ioHandlers = new Map<string, SocketHandler[]>();
  const emitted: Array<{ event: string; data: unknown }> = [];

  const fake: FakeSocket = {
    connected: false,
    auth: undefined,
    handlers,
    ioHandlers,
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
      fake.trigger("disconnect", "io client disconnect");
    },
    removeAllListeners() {
      fake.allListenersRemoved = true;
      handlers.clear();
    },
    io: {
      on(event, cb) {
        const list = ioHandlers.get(event) ?? [];
        list.push(cb);
        ioHandlers.set(event, list);
      },
    },
    trigger(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    triggerIo(event, ...args) {
      for (const cb of ioHandlers.get(event) ?? []) cb(...args);
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

describe("lib/socket", () => {
  beforeEach(() => {
    fake = createFakeSocket();
    ioMock.mockClear();
  });

  afterEach(async () => {
    const { __resetSocketForTests } = await import("../socket");
    const { useRealtimeStore } = await import("@/stores/realtime");
    __resetSocketForTests();
    useRealtimeStore.getState().reset();
    vi.resetModules();
  });

  it("connects to the /events namespace with auth token and flips status to connected", async () => {
    const { connectSocket } = await import("../socket");
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
    const { connectSocket } = await import("../socket");
    const first = connectSocket("token-1");
    const second = connectSocket("token-1");
    expect(first).toBe(second);
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects with the new token on token change", async () => {
    const { connectSocket } = await import("../socket");

    connectSocket("token-1");
    const secondFake = createFakeSocket();
    fake = secondFake;
    connectSocket("token-2");

    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(secondFake.auth).toEqual({ token: "token-2" });
  });

  it("records the last error on connect_error but keeps status disconnected", async () => {
    const { connectSocket } = await import("../socket");
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    fake.trigger("connect_error", new Error("boom"));

    expect(useRealtimeStore.getState().status).toBe("disconnected");
    expect(useRealtimeStore.getState().lastError).toBe("boom");
  });

  it("does not set lastError when the disconnect was client-initiated", async () => {
    const { connectSocket, disconnectSocket } = await import("../socket");
    const { useRealtimeStore } = await import("@/stores/realtime");

    connectSocket(null);
    fake.trigger("connect");
    disconnectSocket();

    expect(useRealtimeStore.getState().status).toBe("disconnected");
    expect(useRealtimeStore.getState().lastError).toBeNull();
  });

  it("subscribeHazards emits the correct event payload", async () => {
    const { connectSocket, subscribeHazards } = await import("../socket");
    connectSocket(null);
    subscribeHazards(49.82, 18.26, 5000);

    expect(fake.emitted).toContainEqual({
      event: "subscribe:hazards",
      data: { lat: 49.82, lng: 18.26, radius_m: 5000 },
    });
  });

  it("onHazardNew invokes the callback for hazard:new events and unsubscribes cleanly", async () => {
    const { connectSocket, onHazardNew } = await import("../socket");
    connectSocket(null);

    const received: unknown[] = [];
    const unsubscribe = onHazardNew((h) => received.push(h));

    fake.trigger("hazard:new", { id: "h-1", hazard_type: "pothole" });
    expect(received).toHaveLength(1);

    unsubscribe();
    fake.trigger("hazard:new", { id: "h-2", hazard_type: "gravel" });
    expect(received).toHaveLength(1);
  });
});
