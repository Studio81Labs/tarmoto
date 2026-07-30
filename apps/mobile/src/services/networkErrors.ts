/**
 * Shared error classifiers used by every offline-aware queue (sensor
 * uploads, hazard reports, review submission). Three buckets drive
 * each queue's drain behavior:
 *
 *   - Network failures (no HTTP status, e.g. fetch threw before a
 *     response landed) mean the link itself is down. Stop draining,
 *     flag `networkFailed`, and leave everything queued for next time.
 *
 *   - Transient server failures (5xx, 408, 429) reach the server but
 *     indicate a temporary condition — an outage, a cold cache, a
 *     rate limit. Treat them like network failures for queueing
 *     purposes (keep queued, stop draining) but don't flag
 *     `networkFailed` because the link itself is fine.
 *
 *   - Client errors (other 4xx: 400/401/403/404/…) are poison pills.
 *     The payload itself is wrong or the auth is gone; retrying the
 *     same bytes forever won't fix it. Callers bump attempts and drop
 *     after a conservative threshold so one bad report can't starve
 *     the rest.
 *
 * The classifiers accept the `ApiError` thrown by the typed facade
 * (carries `.status`) AND raw `TypeError`s thrown by fetch when the
 * link is down — that's what React Native surfaces for offline /
 * timeout / DNS failures since fetch has no axios-style code field.
 */

import { FEATURE_LIMIT_EXCEEDED, HAZARD_PHOTO_EXPIRED } from "@tarmoto/shared";

function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isNetworkDownError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // A response landed → not a transport-level failure.
  if (getStatus(error) !== undefined) return false;
  // Our 15 s request-timeout helper substitutes a `TimeoutError`
  // for the generic `AbortError` whenever its timer fires, so
  // matching by name routes ONLY timer-driven aborts to the
  // queue's "queue for later" path. A generic `AbortError` from
  // caller-driven cancellation (e.g. rider taps × on a photo
  // upload) keeps its native shape and bubbles up to the caller —
  // otherwise a future cancellable operation routed through one
  // of the queues would silently re-queue cancelled requests.
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name === "TimeoutError") return true;
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
  return /network|timeout|offline|disconnected|fetch/i.test(message);
}

export function isTransientServerError(error: unknown): boolean {
  const status = getStatus(error);
  if (typeof status !== "number") return false;
  // 408 and 429 are explicitly retry-safe per RFC 9110; 5xx covers
  // the catch-all server-side faults.
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Either category counts as "don't lose the payload, try again later". */
export function isRetriableError(error: unknown): boolean {
  return isNetworkDownError(error) || isTransientServerError(error);
}

/**
 * A `FEATURE_LIMIT_EXCEEDED` 403 (e.g. the `hazard_reports_per_day` cap). The
 * payload is well-formed and the auth is valid — the caller has simply hit a
 * rolling-window rate cap that clears with time (or an operator raising it).
 * Deliberately NOT folded into `isRetriableError`: unlike a network/transient
 * fault it must NOT be auto-retried on a fresh live submit (the interactive
 * caller shows a "limit reached" message instead), but a queue drain must
 * treat it as a deferred stop that RETAINS the entry without burning its retry
 * budget — otherwise a genuine offline report is silently dropped after three
 * capped drains before the 24h window advances.
 */
export function isFeatureLimitError(error: unknown): boolean {
  if (getStatus(error) !== 403) return false;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return false;
  return (body as { code?: unknown }).code === FEATURE_LIMIT_EXCEEDED;
}

/**
 * A `HAZARD_PHOTO_EXPIRED` 409: the report tried to attach a managed photo whose
 * upload the backend's orphan sweep already reclaimed (the report sat queued
 * past the 24h grace window). The report itself is valid — only the cached
 * remote photo URL is stale. The uploader recovers by re-uploading from the
 * retained local `photoUri` and resubmitting once, so the photo isn't lost.
 * Deliberately NOT retriable/poison: it's handled in-band, not by the queue's
 * retry-budget accounting.
 */
export function isHazardPhotoExpiredError(error: unknown): boolean {
  if (getStatus(error) !== 409) return false;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return false;
  return (body as { code?: unknown }).code === HAZARD_PHOTO_EXPIRED;
}
