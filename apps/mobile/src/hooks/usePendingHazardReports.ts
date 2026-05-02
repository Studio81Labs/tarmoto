/**
 * Hook: usePendingHazardReports — US-4 follow-up.
 *
 * Mirrors `usePendingUploads` for the hazard-report queue. Riders can
 * see the pending count from Settings and trigger a manual drain when
 * they're back on a good network. The hook subscribes to the queue on
 * mount so the count stays current if a background submit enqueues or
 * drains an entry elsewhere in the app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { getPendingCount, subscribePending } from "@/services/hazardQueue";

export interface PendingHazardReportsRetryOutcome {
  /** Reports that successfully POSTed during this retry. */
  flushed: number;
  /** Reports dropped permanently after exhausting their retry budget. */
  failed: number;
  /** Reports still queued when the drain stopped. */
  remaining: number;
}

export interface PendingHazardReportsState {
  count: number;
  /** True while a manual retry is in flight so UI can disable the button. */
  isRetrying: boolean;
  /** Snapshot of the most recent retry — consumed by the result toast. */
  lastResult: PendingHazardReportsRetryOutcome | null;
  retry: () => Promise<void>;
}

export function usePendingHazardReports(): PendingHazardReportsState {
  const [count, setCount] = useState<number>(() => getPendingCount());
  const [isRetrying, setIsRetrying] = useState(false);
  const [lastResult, setLastResult] =
    useState<PendingHazardReportsRetryOutcome | null>(null);
  // Synchronous re-entrancy guard — same rationale as
  // `usePendingUploads`: a rapid double-tap fires the second call before
  // React commits the `isRetrying = true` state from the first.
  const retryInFlightRef = useRef(false);

  useEffect(() => subscribePending(setCount), []);

  const retry = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setIsRetrying(true);
    setLastResult(null);
    // Snapshot before drain so we can derive `failed` (poison pills
    // dropped after their retry budget) as `before - flushed - remaining`.
    const before = getPendingCount();
    try {
      const { flushed, remaining } = await api.flushPendingHazardReports();
      const failed = Math.max(0, before - flushed - remaining);
      setLastResult({ flushed, failed, remaining });
    } finally {
      retryInFlightRef.current = false;
      setIsRetrying(false);
    }
  }, []);

  return { count, isRetrying, lastResult, retry };
}
