import createFetchClient, {
  type Client,
  type ClientOptions,
} from "openapi-fetch";

import type { paths } from "./generated/schema";

/**
 * Raw openapi-fetch client, strongly typed against the generated
 * `paths`. Mirrors the previous `createApiClient` signature so
 * existing consumers (companion's `lib/api.ts`, mobile's
 * `typedClient.ts`) keep working with minimal import-site churn.
 *
 * Mobile pulls this via the default package entry; the React
 * Query helper lives in `./react-query` so RN apps that don't
 * use TanStack Query don't pay for `openapi-react-query` /
 * `@tanstack/react-query` as a transitive dep.
 */
export type TarmotoClient = Client<paths>;

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
  const client = createFetchClient<paths>(rest);

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
