import { createTarmotoClient } from "@tarmoto/openapi-client";
import { API_HOST_SERVER } from "@/lib/config";

/**
 * Server-side typed client for SSR / public reads and the auth bootstrap.
 *
 * Deliberately built WITHOUT the browser refresh middleware: `getToken`,
 * `onUnauthorized`, and `onUnauthorizedRetry` all depend on the Zustand auth
 * store + NextAuth `getSession()`, which are client-only. Server callers hit
 * public endpoints (share pages, best-roads) or the auth endpoints themselves,
 * and attach a bearer explicitly via per-request `headers` when they need one.
 *
 * `baseUrl` is the host only — the generated spec paths already carry the
 * `/api/v1` prefix (e.g. `apiServer.GET("/api/v1/trip-shares/{token}")`).
 */
export const apiServer = createTarmotoClient({ baseUrl: API_HOST_SERVER });
