import { act, render, screen } from "@testing-library/react";
import { OfflineIndicator } from "./OfflineIndicator";
import { useRealtimeStore } from "@/stores/realtime";
import { NETWORK_RECONNECTED_EVENT } from "@/lib/network-status";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

describe("OfflineIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRealtimeStore.getState().setStatus("connected");
    setOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows full offline state from browser network events", () => {
    render(<OfflineIndicator />);

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("distinguishes realtime reconnect while the browser is online", () => {
    render(<OfflineIndicator />);

    act(() => {
      useRealtimeStore.getState().setStatus("connecting");
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });

  it("announces reconnect so data surfaces can refresh", () => {
    const listener = vi.fn();
    window.addEventListener(NETWORK_RECONNECTED_EVENT, listener);

    render(<OfflineIndicator />);

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(NETWORK_RECONNECTED_EVENT, listener);
  });
});
