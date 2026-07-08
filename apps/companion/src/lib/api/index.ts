// Public API facade. The per-endpoint-family modules live alongside this
// barrel; callers keep importing from `@/lib/api` unchanged. See #861.
//
// `openApiData`, `reqSignal`, and the `JsonResponse`/`JsonRequest` helpers stay
// internal to this directory (imported directly from `./client` by the family
// modules) — they are not part of the public surface.
export { api, $api, ApiError } from "./client";

export * from "./auth";
export * from "./trips";
export * from "./routing";
export * from "./trip-folders";
export * from "./trip-shares";
export * from "./trip-collab";
export * from "./exploration";
export * from "./collections";
export * from "./map-shares";
export * from "./hazards";
export * from "./roads";
export * from "./closures";
export * from "./poi";
export * from "./community";
export * from "./passes";
export * from "./users";
export * from "./account";
