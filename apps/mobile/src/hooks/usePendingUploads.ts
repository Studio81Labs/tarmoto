/**
 * Hook: usePendingUploads — US-18 AC #4.
 *
 * Exposes the offline sensor-upload backlog as React state. Components
 * can read `count` directly for a badge, and `retry()` drives an
 * on-demand flush (used from Settings). The hook subscribes to the
 * queue on mount so the count updates when a background enqueue or
 * drain happens elsewhere in the app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { getPendingCount, subscribePending } from "@/services/offlineQueue";

export interface PendingUploadsState {
  count: number;
  /** True while a manual retry is in flight so UI can disable the button. */
  isRetrying: boolean;
  /** Rows flushed by the most recent retry — consumed by a toast/snackbar. */
  lastFlushed: number | null;
  retry: () => Promise<void>;
}

export function usePendingUploads(): PendingUploadsState {
  const [count, setCount] = useState<number>(() => getPendingCount());
  const [isRetrying, setIsRetrying] = useState(false);
  const [lastFlushed, setLastFlushed] = useState<number | null>(null);
  // A rapid double-tap fires the second call before React commits the
  // `isRetrying = true` state from the first, so a state-based guard
  // would leak through. The underlying drain has its own lock, but the
  // second call would still no-op through `drainInFlight`, flip
  // `lastFlushed` to 0, and turn the spinner off mid-flush. A ref
  // flips synchronously and closes that window.
  const retryInFlightRef = useRef(false);

  useEffect(() => subscribePending(setCount), []);

  const retry = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setIsRetrying(true);
    setLastFlushed(null);
    try {
      const { flushed } = await api.flushPendingSensorUploads();
      setLastFlushed(flushed);
    } finally {
      retryInFlightRef.current = false;
      // The subscription above already refreshed `count`, so we only
      // need to flip the spinner off here.
      setIsRetrying(false);
    }
  }, []);

  return { count, isRetrying, lastFlushed, retry };
}
