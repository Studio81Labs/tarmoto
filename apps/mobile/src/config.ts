import { Platform } from "react-native";
import { TARMOTO_API_URL, TARMOTO_MAP_STYLE_URL } from "@env";

const PRODUCTION_API_URL = "https://api.tarmoto.app";
const PRODUCTION_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

function configuredUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export function resolveApiBaseUrl(
  value: string | undefined,
  platform: string,
  isDev: boolean,
): string {
  const configured = configuredUrl(value);
  if (configured) return configured;
  if (!isDev) return PRODUCTION_API_URL;
  return platform === "android"
    ? "http://10.0.2.2:3000"
    : "http://localhost:3000";
}

/**
 * Base URL for the Tarmoto backend (host only — no path prefix).
 *
 * The typed openapi-fetch client appends the spec-defined `/api/v1/...`
 * path to this base URL on every request. Anything that talks to the
 * backend should resolve its base from this constant.
 */
export const API_BASE_URL = resolveApiBaseUrl(
  TARMOTO_API_URL,
  Platform.OS,
  __DEV__,
);

/** Production-grade OSM/OpenMapTiles basemap shared with the companion. */
export const MAP_STYLE_URL =
  configuredUrl(TARMOTO_MAP_STYLE_URL) ?? PRODUCTION_MAP_STYLE_URL;
