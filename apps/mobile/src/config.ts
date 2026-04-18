/**
 * App-wide runtime configuration.
 *
 * Keep this file side-effect-free so both the axios client and UI
 * helpers can import from it without pulling in native bindings.
 */

/**
 * Base URL for the Tarmoto backend, versioned. Dev points at a local
 * NestJS instance; prod points at the hosted API. Change both ends here —
 * any module that talks to the backend imports from this constant.
 */
export const API_BASE_URL = __DEV__
  ? "http://localhost:3000/v1"
  : "https://api.tarmoto.app/v1";
