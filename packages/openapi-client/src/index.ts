export type { paths, components, operations } from "./generated/schema";
export {
  createTarmotoClient,
  type TarmotoClient,
  type CreateTarmotoClientOptions,
} from "./client";

// React Query bindings live in `./react-query`. Importing them
// from the default entry would pull `openapi-react-query` +
// `@tanstack/react-query` into every consumer, including mobile
// (which doesn't use TanStack Query). Companion imports them
// explicitly via `@tarmoto/openapi-client/react-query`.
