/**
 * Shared axios error classifiers used by every offline-aware queue
 * (sensor uploads, hazard reports). Three buckets drive each queue's
 * drain behavior:
 *
 *   - Network failures (no `response`) mean the link itself is down.
 *     Stop draining, flag `networkFailed`, and leave everything queued
 *     for next time.
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
 */

import type { AxiosError } from "axios";

export function isNetworkDownError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const axiosErr = error as AxiosError;
  if (axiosErr.response) return false;
  const code = axiosErr.code ?? "";
  if (
    code === "ERR_NETWORK" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }
  const message = typeof axiosErr.message === "string" ? axiosErr.message : "";
  return /network|timeout|offline|disconnected/i.test(message);
}

export function isTransientServerError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as AxiosError).response?.status;
  if (typeof status !== "number") return false;
  // 408 and 429 are explicitly retry-safe per RFC 9110; 5xx covers the
  // catch-all server-side faults.
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Either category counts as "don't lose the payload, try again later". */
export function isRetriableError(error: unknown): boolean {
  return isNetworkDownError(error) || isTransientServerError(error);
}
