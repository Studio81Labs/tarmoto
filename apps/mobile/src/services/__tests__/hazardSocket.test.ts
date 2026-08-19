/**
 * #341 — hazardSocket service tests.
 *
 * Covers the AppState-driven lifecycle, the (re)connect-replay path
 * for the geographic subscription, and the dismissal payload flow.
 *
 * The socket factory is stubbed via `jest.mock("socket.io-client")`
 * so we never open a real network socket; AppState is driven by
 * spying on `addEventListener` and capturing the registered listener.
 */

jest.mock("react-native-mmkv", () => {
  const stores = new Map<string, Map<string, unknown>>();
  return {
    createMMKV: ({ id }: { id: string }) => {
      let store = stores.get(id);
      if (!store) {
        store = new Map();
        stores.set(id, store);
      }
      return {
        getString: (k: string) => store!.get(k) as string | undefined,
        set: (k: string, v: unknown) => {
          store!.set(k, v);
        },
        remove: (k: string) => {
          store!.delete(k);
        },
        getAllKeys: () => Array.from(store!.keys()),
      };
    },
  };
});

type SocketEventHandler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  on: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  __handlers: Map<string, SocketEventHandler>;
  __auth: ((cb: (data: unknown) => void) => void) | null;
  __trigger: (event: string, ...args: unknown[]) => void;
}

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, SocketEventHandler>();
  const socket: FakeSocket = {
    connected: false,
    on: jest.fn((event: string, handler: SocketEventHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: jest.fn(() => socket),
    disconnect: jest.fn(() => {
      socket.connected = false;
      return socket;
    }),
    __handlers: handlers,
    __auth: null,
    __trigger: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
  };
  return socket;
}

// Jest hoists `jest.mock` calls above imports, so any out-of-scope
// reference inside the factory must use a `mock`-prefixed name. We
// stash the spy here and read it in tests via `getIoMock()`.
const mockIo = jest.fn();

jest.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => mockIo(...args),
}));

import { AppState, type AppStateStatus } from "react-native";
import { __HazardSocketServiceForTest } from "../hazardSocket";
import type { HazardAlertEvent } from "@/types";

let nextSocket: FakeSocket | null = null;

function makeHazardAlert(
  overrides: Partial<HazardAlertEvent> = {},
): HazardAlertEvent {
  return {
    id: "h-1",
    lat: 49.8,
    lng: 18.2,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: null,
    road_name: null,
    created_at: "2026-05-02T10:00:00.000Z",
    expires_at: "2026-05-03T10:00:00.000Z",
    ...overrides,
  };
}

type AppStateListener = (state: string) => void;

function captureAppStateListener(): AppStateListener {
  const addSpy = jest.spyOn(AppState, "addEventListener");
  // The most-recent registration's listener — services register on
  // `start`, so this lets us simulate background/foreground transitions
  // after wiring is complete.
  const calls = addSpy.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("expected AppState.addEventListener to be called");
  return last[1] as AppStateListener;
}

describe("hazardSocket", () => {
  let originalAppState: AppStateStatus;

  beforeEach(() => {
    nextSocket = null;
    mockIo.mockReset();
    mockIo.mockImplementation((url: string, opts: { auth?: unknown }) => {
      const socket = createFakeSocket();
      if (typeof opts?.auth === "function") {
        socket.__auth = opts.auth as FakeSocket["__auth"];
      }
      nextSocket = socket;
      return socket;
    });
    // Default to foreground so `start` opens immediately. RN exposes
    // `currentState` as a plain (writable) property, not a getter, so
    // we assign it directly rather than spying.
    originalAppState = AppState.currentState;
    (AppState as { currentState: AppStateStatus }).currentState = "active";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (AppState as { currentState: AppStateStatus }).currentState =
      originalAppState;
  });

  it("opens a socket and replays subscribe:hazards on connect when foreground", () => {
    const service = new __HazardSocketServiceForTest();
    const onHazard = jest.fn();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard });

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(nextSocket).not.toBeNull();
    const socket = nextSocket!;

    // Simulate the socket.io `connect` event firing — the service
    // should then issue a subscribe:hazards with the rider's centre.
    socket.connected = true;
    socket.__trigger("connect");

    expect(socket.emit).toHaveBeenCalledWith("subscribe:hazards", {
      lat: 49.8,
      lng: 18.2,
      radius_m: 10000,
    });

    service.stop();
  });

  it("dispatches hazard:new events to the registered handler", () => {
    const service = new __HazardSocketServiceForTest();
    const onHazard = jest.fn();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard });

    const socket = nextSocket!;
    const event = makeHazardAlert({ id: "fresh" });
    socket.__trigger("hazard:new", event);

    expect(onHazard).toHaveBeenCalledTimes(1);
    expect(onHazard).toHaveBeenCalledWith(event);

    service.stop();
  });

  it("disconnects on background and re-opens on the next foreground transition", () => {
    const service = new __HazardSocketServiceForTest();
    const onHazard = jest.fn();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard });

    const listener = captureAppStateListener();
    const firstSocket = nextSocket!;
    firstSocket.connected = true;

    // Background — service tears the socket down so we don't burn
    // cellular bandwidth on a screen the rider can't see.
    listener("background");
    expect(firstSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(false);

    // Foreground — service opens a brand-new socket. The replay path
    // re-emits subscribe:hazards on `connect`, restoring the cells.
    nextSocket = null;
    listener("active");
    expect(mockIo).toHaveBeenCalledTimes(2);

    const secondSocket = nextSocket!;
    secondSocket.connected = true;
    secondSocket.__trigger("connect");
    expect(secondSocket.emit).toHaveBeenCalledWith(
      "subscribe:hazards",
      expect.objectContaining({ lat: 49.8, lng: 18.2 }),
    );

    service.stop();
  });

  it("re-emits subscribe:hazards on socket.io's auto-reconnect", () => {
    const service = new __HazardSocketServiceForTest();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn() });
    const socket = nextSocket!;

    // Initial connect.
    socket.connected = true;
    socket.__trigger("connect");
    expect(socket.emit).toHaveBeenCalledTimes(1);

    // Network drop + reconnect: socket.io fires `connect` again on
    // the same socket. The service should replay subscribe:hazards so
    // the rider keeps receiving fan-out without a screen remount.
    socket.__trigger("connect");
    expect(socket.emit).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("updateSubscription re-emits when connected, defers when not", () => {
    const service = new __HazardSocketServiceForTest();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn() });
    const socket = nextSocket!;

    // Not yet connected — no emit. The next `connect` will pick up
    // the new subscription via the replay path.
    socket.connected = false;
    service.updateSubscription({ lat: 50.0, lng: 18.5 });
    expect(socket.emit).not.toHaveBeenCalled();

    // Once connected, an explicit updateSubscription emits directly.
    socket.connected = true;
    service.updateSubscription({ lat: 50.1, lng: 18.6 });
    expect(socket.emit).toHaveBeenCalledWith("subscribe:hazards", {
      lat: 50.1,
      lng: 18.6,
      radius_m: 10000,
    });

    service.stop();
  });

  it("does not open a socket when the app is in the background at start time", () => {
    (AppState as { currentState: AppStateStatus }).currentState = "background";
    const service = new __HazardSocketServiceForTest();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn() });

    expect(mockIo).not.toHaveBeenCalled();

    // First foreground transition opens the socket.
    const listener = captureAppStateListener();
    listener("active");
    expect(mockIo).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("stop tears down both the socket and the AppState listener", () => {
    const removeSpy = jest.fn();
    // Stub the listener subscription so we can assert the service
    // unhooks the exact `remove` handle it received from `start`.
    jest
      .spyOn(AppState, "addEventListener")
      .mockReturnValue({ remove: removeSpy } as ReturnType<
        typeof AppState.addEventListener
      >);

    const service = new __HazardSocketServiceForTest();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn() });
    const socket = nextSocket!;
    socket.connected = true;

    service.stop();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards typed gateway errors to the optional onError handler", () => {
    const service = new __HazardSocketServiceForTest();
    const onError = jest.fn();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn(), onError });

    const socket = nextSocket!;
    socket.__trigger("error", { message: "rate limited" });
    expect(onError).toHaveBeenCalledWith("rate limited");

    socket.__trigger("error", undefined);
    expect(onError).toHaveBeenCalledWith("socket error");

    service.stop();
  });

  it("auth callback re-reads the token on every connect attempt", () => {
    // The socket reads the shared in-memory token mirror (#1231) — seed it
    // through the real API rather than a private MMKV namespace.
    const { storeTokens, clearTokens } =
      require("../typedClient") as typeof import("../typedClient");
    storeTokens({ access_token: "tok-1", refresh_token: "r-1" } as never);

    const service = new __HazardSocketServiceForTest();
    service.start({ lat: 49.8, lng: 18.2 }, { onHazard: jest.fn() });

    const socket = nextSocket!;
    expect(socket.__auth).not.toBeNull();
    let captured: unknown = null;
    socket.__auth!((data) => {
      captured = data;
    });
    expect(captured).toEqual({ token: "tok-1" });

    // Rotated mid-session: the next read must surface the new token.
    storeTokens({ access_token: "tok-2", refresh_token: "r-2" } as never);
    captured = null;
    socket.__auth!((data) => {
      captured = data;
    });
    expect(captured).toEqual({ token: "tok-2" });

    service.stop();
    clearTokens();
  });
});
