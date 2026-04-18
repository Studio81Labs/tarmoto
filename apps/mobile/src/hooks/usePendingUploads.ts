/**
 * Hook: usePendingUploads — US-18 AC #4.
 *
 * Exposes the offline sensor-upload backlog as React state. Components
 * can read `count` directly for a badge, and `retry()` drives an
 * on-demand flush (used from Settings). The hook subscribes to the
 * queue on mount so the count updates when a background enqueue or
 * drain happens elsewhere in the app.
 */

import { useCallback, useEffect, useState } from "react";
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

  useEffect(() => subscribePending(setCount), []);

  const retry = useCallback(async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setLastFlushed(null);
    try {
      const { flushed } = await api.flushPendingSensorUploads();
      setLastFlushed(flushed);
    } finally {
      // The subscription above already refreshed `count`, so we only
      // need to flip the spinner off here.
      setIsRetrying(false);
    }
  }, [isRetrying]);

  return { count, isRetrying, lastFlushed, retry };
}
