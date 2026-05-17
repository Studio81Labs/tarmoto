import createFetchClient, {
  type Client,
  type ClientOptions,
} from "openapi-fetch";
import createReactQueryClient from "openapi-react-query";

import type { paths } from "./generated/schema";

/**
 * Raw openapi-fetch client, strongly typed against the generated
 * `paths`. Mirrors the previous `createApiClient` signature so
 * existing consumers (companion's `lib/api.ts`, mobile's
 * `typedClient.ts`) keep working with minimal import-site churn.
 */
export type TarmotoClient = Client<paths>;

/**
 * React Query wrapper. Exposes `useQuery` / `useMutation` factories
 * pre-bound to the typed paths so consumers can call
 * `$api.useQuery("get", "/api/v1/trips")` and have the full param
 * + response shape inferred. Optional — non-React consumers
 * (mobile RN screens that prefer their own data layer, the e2e
 * mock backend, scripts) can use `createTarmotoClient` alone.
 */
export type TarmotoQueryClient = ReturnType<
  typeof createReactQueryClient<paths>
>;

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

export function createTarmotoQueryClient(
  client: TarmotoClient,
): TarmotoQueryClient {
  return createReactQueryClient<paths>(client);
}
