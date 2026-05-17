import createFetchClient, {
  type Client,
  type ClientOptions,
} from "openapi-fetch";

import type { BrowserSafePaths } from "./browser-safe";

/**
 * Raw openapi-fetch client, strongly typed against the
 * `BrowserSafePaths` view of the generated paths — internal-only
 * headers like `X-Internal-Token` are stripped at the type level,
 * so a browser consumer can't accidentally call internal routes
 * with a token it shouldn't have. See `./browser-safe`.
 *
 * Mobile pulls this via the default package entry; the React
 * Query helper lives in `./react-query` so RN apps that don't
 * use TanStack Query don't pay for `openapi-react-query` /
 * `@tanstack/react-query` as a transitive dep.
 */
export type TarmotoClient = Client<BrowserSafePaths>;

export interface CreateTarmotoClientOptions extends ClientOptions {
  /**
   * Returns the current bearer token (or null when unauthenticated).
   * Read on every request so a token refresh after the client was
   * built still flows through.
   */
  getToken?: () => string | null;
  /**
   * Called whenever a response returns 401. The companion uses this
   * to clear the Zustand auth-store session and bounce the user to
   * /login.
   */
  onUnauthorized?: () => void;
}

export function createTarmotoClient(
  options: CreateTarmotoClientOptions = {},
): TarmotoClient {
  const { getToken, onUnauthorized, ...rest } = options;
  const client = createFetchClient<BrowserSafePaths>(rest);

  if (getToken) {
    client.use({
      async onRequest({ request }) {
        const token = getToken();
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
        return request;
      },
    });
  }
  if (onUnauthorized) {
    client.use({
      async onResponse({ response }) {
        if (response.status === 401) {
          onUnauthorized();
        }
        return response;
      },
    });
  }

  return client;
}
