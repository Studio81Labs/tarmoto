/**
 * Resolve the backend `/events` socket.io namespace URL from the
 * shared `API_BASE_URL`. Used by every socket-driven service in the
 * app (`groupRideSocket`, `hazardSocket`, …) so a future API base
 * change only has to land in one place.
 *
 * The API base may carry a `/v1` REST prefix that the gateway
 * namespace does not, so we strip the path before joining `/events`.
 */
import { API_BASE_URL } from "@/config";

export function resolveEventsUrl(): string {
  try {
    const url = new URL(API_BASE_URL);
    return `${url.protocol}//${url.host}/events`;
  } catch {
    // Fallback for malformed bases (shouldn't happen at runtime, but
    // keeps the import side-effect-free under test environments).
    return `${API_BASE_URL.replace(/\/v1\/?$/, "")}/events`;
  }
}
