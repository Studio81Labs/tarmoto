import { create } from "zustand";

export type RealtimeStatus = "disconnected" | "connecting" | "connected";

interface RealtimeState {
  status: RealtimeStatus;
  /** Timestamp (ms) of the most recent successful `connect` event. */
  connectedAt: number | null;
  /** Last cataloged connection error, safe to render in rider-facing UI. */
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
