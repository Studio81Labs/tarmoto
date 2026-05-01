/**
 * App-wide runtime configuration.
 *
 * Keep this file side-effect-free so both the API client and UI
 * helpers can import from it without pulling in native bindings.
 */

/**
 * Base URL for the Tarmoto backend (host only — no path prefix).
 *
 * The typed openapi-fetch client appends the spec-defined `/api/v1/...`
 * path to this base URL on every request. Anything that talks to the
 * backend should resolve its base from this constant.
 */
export const API_BASE_URL = __DEV__
  ? "http://localhost:3000"
  : "https://api.tarmoto.app";
