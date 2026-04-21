import { create } from "zustand";

export type RealtimeStatus = "disconnected" | "connecting" | "connected";

interface RealtimeState {
  status: RealtimeStatus;
  /** Timestamp (ms) of the most recent successful `connect` event. */
  connectedAt: number | null;
  /** Last error reason surfaced by socket.io (`connect_error` or `disconnect`). */
  lastError: string | null;

  setStatus: (status: RealtimeStatus) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  status: "disconnected",
  connectedAt: null,
  lastError: null,

  setStatus: (status) =>
    set((s) => ({
      status,
      connectedAt: status === "connected" ? Date.now() : s.connectedAt,
    })),
  setError: (error) => set({ lastError: error }),
  reset: () =>
    set({ status: "disconnected", connectedAt: null, lastError: null }),
}));
