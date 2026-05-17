import createReactQueryClient from "openapi-react-query";

import type { paths } from "./generated/schema";
import type { TarmotoClient } from "./client";

/**
 * React Query wrapper around the raw `TarmotoClient`. Lives in its
 * own subpath so non-React consumers (mobile RN, scripts) can
 * import `@tarmoto/openapi-client` without pulling
 * `openapi-react-query` + `@tanstack/react-query` as transitive
 * deps they don't use.
 *
 * Consumers import:
 *   `import { createTarmotoQueryClient } from "@tarmoto/openapi-client/react-query";`
 *
 * Exposes `useQuery` / `useMutation` factories pre-bound to the
 * typed paths so consumers can call
 * `$api.useQuery("get", "/api/v1/trips")` and have the full param
 * + response shape inferred.
 */
export type TarmotoQueryClient = ReturnType<
  typeof createReactQueryClient<paths>
>;

export function createTarmotoQueryClient(
  client: TarmotoClient,
): TarmotoQueryClient {
  return createReactQueryClient<paths>(client);
}
