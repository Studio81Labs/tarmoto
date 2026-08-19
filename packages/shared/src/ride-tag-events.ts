/**
 * Rider-asserted surface labels captured during an active ride
 * (research issue #7).
 *
 * Riders cannot reliably tag every surface category that the on-device
 * classifier can output (e.g. distinguishing concrete from asphalt at
 * speed is unreasonable). This label set is the rider-facing
 * vocabulary — coarser than the canonical {@link SurfaceType} /
 * {@link QualityClass} pair so that one tap fully describes the
 * stretch the rider just entered.
 *
 * Each label is mapped to a `(SurfaceType, QualityClass)` pair via
 * {@link SURFACE_LABEL_TO_TRUTH}; the backend stores BOTH the raw
 * label and the derived pair on each affected `surface_readings` row
 * so future training can pick whichever resolution it prefers.
 */
import type { SurfaceType } from "./constants";

/**
 * Whether a label describes a sustained span (applies from its `t`
 * until the next tag) or a transient point event (applies to the
 * window straddling its `t`).
 */
export type RideTagEventKind = "span" | "point";

export const SURFACE_LABELS = [
  "smooth_asphalt",
  "rough_asphalt",
  "cobblestone",
  "gravel",
  "dirt",
  "pothole",
] as const;

export type SurfaceLabel = (typeof SURFACE_LABELS)[number];

export type RiderQualityLabel =
  "excellent" | "good" | "fair" | "poor" | "very_poor";

/**
 * One tap on the in-ride tagging UI. `t` is the millisecond timestamp
 * captured at the moment of the tap; `lat`/`lng` are optional because
 * a tag can fire while GPS is reacquiring (tunnel exit, cold start) —
 * the backend's tag→window join is timestamp-driven, not location-
 * driven, so the GPS values are kept only for forensic display.
 */
export interface RideTagEvent {
  t: number;
  lat?: number;
  lng?: number;
  label: SurfaceLabel;
}

/**
 * How long a `pothole` tag's window of influence extends on either
 * side of its `t`. Two seconds covers ~17 m at 30 km/h and 28 m at
 * 50 km/h — wide enough that the surface_readings window covering
 * the impact moment is reliably tagged even when the rider taps a
 * beat after the bump.
 */
export const POINT_TAG_HALF_WINDOW_MS = 1000;

/**
 * Maximum number of `RideTagEvent`s permitted in a single
 * `POST /sensor/upload` payload. Bound enforced by both:
 *
 *   - the backend DTO's `@ArrayMaxSize(MAX_TAG_EVENTS_PER_UPLOAD)`
 *     (rejects oversized requests with HTTP 400)
 *   - the mobile sensor service's tag buffer (drops oldest taps
 *     past the cap so a long labelling ride never produces a
 *     payload the backend has to reject)
 *
 * Keeping these in sync via a shared constant prevents the
 * failure mode where the offline queue's non-retriable 4xx path
 * silently drops both the tags AND the readings of a long ride.
 *
 * 500 covers a generous ~30-minute ride at one tap every ~3 s.
 * Riders who tag more aggressively still get their most recent
 * 500 taps; the older taps are dropped client-side rather than
 * the entire batch being rejected.
 */
export const MAX_TAG_EVENTS_PER_UPLOAD = 500;

/**
 * Canonicalises one rider tap into the storage-side label pair plus
 * its temporal kind. The backend uses this in two places:
 *
 *  1. Persisting the raw `ride_tag_events` row exactly as the rider
 *     entered it (for audit / re-labeling).
 *  2. Joining each `surface_readings` window to the tag whose span /
 *     point covers the window's midpoint timestamp, then writing
 *     `rider_surface_label` and `rider_quality_label` so research
 *     queries can train against rider-asserted ground truth.
 */
export const SURFACE_LABEL_TO_TRUTH: Record<
  SurfaceLabel,
  {
    surface_type: SurfaceType;
    quality_label: RiderQualityLabel;
    kind: RideTagEventKind;
  }
> = {
  smooth_asphalt: {
    surface_type: "asphalt",
    quality_label: "excellent",
    kind: "span",
  },
  rough_asphalt: {
    surface_type: "asphalt",
    quality_label: "poor",
    kind: "span",
  },
  cobblestone: {
    surface_type: "cobblestone",
    quality_label: "fair",
    kind: "span",
  },
  gravel: { surface_type: "gravel", quality_label: "fair", kind: "span" },
  dirt: { surface_type: "dirt", quality_label: "fair", kind: "span" },
  pothole: {
    surface_type: "asphalt",
    quality_label: "very_poor",
    kind: "point",
  },
};

/**
 * Resolve the rider tag (if any) that covers a given window timestamp.
 *
 * Span tags apply from their `t` until the next tag (or end of ride).
 * Point tags apply to windows whose midpoint falls within
 * `±POINT_TAG_HALF_WINDOW_MS` of their `t` — including taps that fired
 * *after* the segment's midpoint, because a rider taps "pothole" the
 * moment they feel the impact, not before they reach it. Point tags
 * take priority over the surrounding span — a pothole on cobblestones
 * should still be labelled as a pothole.
 *
 * `events` is not assumed sorted; the caller may pre-sort, but the
 * resolver doesn't rely on it (the buffer is small — ≤500 tags per
 * upload by the DTO contract — so a linear pass is fine and avoids
 * subtle break-too-early bugs when point and span tags interleave).
 *
 * Returns `null` when no tag covers the window so the caller can
 * leave `rider_*` columns null instead of guessing.
 */
export function resolveTagForTimestamp(
  events: readonly RideTagEvent[],
  windowT: number,
): RideTagEvent | null {
  let activeSpan: RideTagEvent | null = null;
  let pointHit: RideTagEvent | null = null;
  for (const ev of events) {
    const truth = SURFACE_LABEL_TO_TRUTH[ev.label];
    if (truth.kind === "span") {
      // Span starts at `ev.t` and runs until the next span tag. Pick
      // the latest span tag whose `t` is still ≤ windowT.
      if (ev.t <= windowT && (!activeSpan || ev.t >= activeSpan.t)) {
        activeSpan = ev;
      }
      continue;
    }
    // Point tag — applies to windows on either side of `t` within
    // the half-window. Last writer wins on duplicate hits, which is
    // harmless because the labels would be identical by definition.
    if (Math.abs(ev.t - windowT) <= POINT_TAG_HALF_WINDOW_MS) {
      pointHit = ev;
    }
  }
  // Point hits override the surrounding span — see fn docstring.
  return pointHit ?? activeSpan;
}
