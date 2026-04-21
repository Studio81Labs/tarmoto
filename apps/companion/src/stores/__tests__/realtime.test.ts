import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtimeStore } from "../realtime";

describe("useRealtimeStore", () => {
  beforeEach(() => {
    useRealtimeStore.getState().reset();
    vi.useRealTimers();
  });

  it("starts disconnected with no error", () => {
    const state = useRealtimeStore.getState();
    expect(state.status).toBe("disconnected");
    expect(state.connectedAt).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("records connectedAt the moment status transitions to connected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00Z"));

    useRealtimeStore.getState().setStatus("connecting");
    expect(useRealtimeStore.getState().connectedAt).toBeNull();

    useRealtimeStore.getState().setStatus("connected");
    expect(useRealtimeStore.getState().connectedAt).toBe(
      new Date("2026-04-21T10:00:00Z").getTime(),
    );
  });

  it("keeps the previous connectedAt when moving back to disconnected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00Z"));
    useRealtimeStore.getState().setStatus("connected");
    const firstConnect = useRealtimeStore.getState().connectedAt;

    vi.setSystemTime(new Date("2026-04-21T10:05:00Z"));
    useRealtimeStore.getState().setStatus("disconnected");

    expect(useRealtimeStore.getState().connectedAt).toBe(firstConnect);
  });

  it("reset clears status, connectedAt, and lastError", () => {
    const s = useRealtimeStore.getState();
    s.setStatus("connected");
    s.setError("network blip");
    s.reset();

    const after = useRealtimeStore.getState();
    expect(after.status).toBe("disconnected");
    expect(after.connectedAt).toBeNull();
    expect(after.lastError).toBeNull();
  });
});
