/**
 * Short-lived request cache for the personalised review read (#1212).
 *
 * A `sys_poi_ratings` flip makes `RoadPreviewScreen` issue TWO personalised
 * reads of `GET /roads/:id/reviews` for the same road: one from the fetch
 * effect's `ratingsEnabled` dependency, one from the `embeddedReviews` echo
 * of the aggregate refresh the same flip triggers. Each read costs the
 * backend a way resolution plus a review query, multiplied by every open
 * preview at the exact moment an operator is shedding load.
 *
 * Coalescing the pair INSIDE the screen was tried in #1209 and reverted: a
 * mark armed by one effect and consumed by another has no reliable way to
 * expire when the request it was armed for fails, and each scoping fix
 * exposed the next gap. Here the request itself is visible, so no
 * cross-effect state is needed: identical reads share one promise.
 *
 * Mechanics:
 *
 *   - Keyed on `(segmentId, viewerId, ratingsEnabled)` — the full identity of
 *     the response. `viewerId` because `is_mine` / `my_vote` are resolved per
 *     viewer; `ratingsEnabled` because the server's answer changes with the
 *     switch (community list vs the viewer's own review only), so a pre-flip
 *     response must never be served to a post-flip read.
 *   - An in-flight read is shared outright; a resolved one is served for
 *     {@link REVIEWS_READ_TTL_MS} after it resolves. The TTL exists ONLY to
 *     collapse the flip burst (the echo read starts one aggregate round-trip
 *     after the flip read resolves) — it is deliberately too short to act as
 *     a data cache, and it does NOT slide: the window is measured from the
 *     first resolution, so periodic triggers cannot suppress reads
 *     indefinitely.
 *   - A REJECTED read deletes its entry immediately, so a failed refresh can
 *     never suppress a later one — the next read always goes to the network
 *     (acceptance criterion of #1212, and the precise defect class that
 *     killed the component-level marks).
 *   - Genuinely fresh reads bypass the window through
 *     {@link invalidateReviewsRead}: the pull-to-refresh gesture invalidates
 *     its segment explicitly, and `api`'s review mutations (create / update /
 *     delete / vote) invalidate when they settle. An explicit invalidation
 *     beats relying on the pull's echo landing after the TTL — a timing
 *     coincidence that would break silently on a fast network.
 *
 * Entries are swept lazily on each read instead of with timers: the map holds
 * at most a handful of sub-second-lived entries, and RN + Jest both get
 * hairier when modules own real timers.
 */

import type { RoadReview } from "@/types";

/**
 * How long a RESOLVED read keeps being served (ms). Long enough for the
 * flip's echo read (issued after the road-detail aggregate round-trip
 * completes) to land inside it on a normal connection; short enough that the
 * cache can only ever collapse a burst, not mask real staleness. On a badly
 * degraded link the echo may miss the window and refetch — that is the
 * pre-#1212 behaviour, and strictly better than serving stale data longer.
 */
export const REVIEWS_READ_TTL_MS = 2_000;

/** The full identity of a personalised review response — see module doc. */
export interface ReviewsReadKey {
  segmentId: string;
  /** `null` for a signed-out viewer (the anonymous-friendly response). */
  viewerId: string | null;
  /** The client-side `sys_poi_ratings` state the read was issued under. */
  ratingsEnabled: boolean;
}

interface CacheEntry {
  /** Kept alongside the composite key so segment-scoped invalidation does
   *  not have to parse keys back apart. */
  segmentId: string;
  promise: Promise<RoadReview[]>;
  /** `null` while the request is in flight; stamped once on resolution. */
  resolvedAt: number | null;
}

const entries = new Map<string, CacheEntry>();

/** JSON tuple rather than string concatenation: ids are backend-issued and a
 *  delimiter collision would silently merge two different targets. */
function cacheKey(key: ReviewsReadKey): string {
  return JSON.stringify([key.segmentId, key.viewerId, key.ratingsEnabled]);
}

function isExpired(entry: CacheEntry, now: number): boolean {
  return (
    entry.resolvedAt !== null && now - entry.resolvedAt > REVIEWS_READ_TTL_MS
  );
}

/**
 * Return the in-flight or just-resolved read for `key`, starting `fetcher`
 * only when neither exists. All sharers receive the same promise — including
 * its rejection, which each caller handles exactly as if it had issued the
 * request itself.
 */
export function dedupeReviewsRead(
  key: ReviewsReadKey,
  fetcher: () => Promise<RoadReview[]>,
): Promise<RoadReview[]> {
  const now = Date.now();
  for (const [staleKey, staleEntry] of entries) {
    if (isExpired(staleEntry, now)) entries.delete(staleKey);
  }
  const composite = cacheKey(key);
  const existing = entries.get(composite);
  // The sweep above already removed expired entries, so anything still here
  // is in flight or within the window.
  if (existing) return existing.promise;

  const entry: CacheEntry = {
    segmentId: key.segmentId,
    resolvedAt: null,
    promise: fetcher().then(
      (reviews) => {
        // Identity check: an invalidation may have evicted this entry while
        // the request was in flight (and a successor may occupy the key).
        // Stamping would resurrect nothing — the map no longer holds it —
        // but guard anyway so a successor's entry is never touched.
        if (entries.get(composite) === entry) entry.resolvedAt = Date.now();
        return reviews;
      },
      (error: unknown) => {
        // A failed read must never suppress a later one: drop the entry so
        // the next read goes to the network. Identity-checked so a rejection
        // landing after an invalidate-and-refetch cannot delete the
        // successor's fresh entry.
        if (entries.get(composite) === entry) entries.delete(composite);
        throw error;
      },
    ),
  };
  entries.set(composite, entry);
  return entry.promise;
}

/**
 * Drop cached reads so the next one goes to the network — for one segment
 * (every viewer / switch state), or every entry when no segment is given
 * (review-vote mutations only know the review id, and the map is small and
 * sub-second-lived, so precision buys nothing there).
 *
 * In-flight entries are evicted too: their holders still settle normally,
 * but no NEW caller joins a request issued before the invalidating event.
 */
export function invalidateReviewsRead(segmentId?: string): void {
  if (segmentId === undefined) {
    entries.clear();
    return;
  }
  for (const [composite, entry] of entries) {
    if (entry.segmentId === segmentId) entries.delete(composite);
  }
}
