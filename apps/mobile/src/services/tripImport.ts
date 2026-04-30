/**
 * Mobile-side glue for US-20 GPX/KML import. Handles the document-picker
 * lifecycle, file read, and parser invocation, returning a normalised
 * payload that the trip-create flow can hand straight to the backend's
 * `POST /trips/import` endpoint. The actual GPX/KML parsing lives in
 * `@tarmoto/shared` so the same logic powers the companion's web import.
 */

import {
  pick,
  errorCodes,
  isErrorWithCode,
  types,
} from "@react-native-documents/picker";
import RNFS from "react-native-fs";
import { parseImportedRoute, type ImportedRoute } from "@tarmoto/shared";

export type TripImportOutcome =
  | { ok: true; route: ImportedRoute; filename: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Open the system document picker, read the chosen file, and parse it.
 *
 * Errors collapse into `{ ok: false }` so callers don't need to handle
 * picker exceptions vs parser failures separately. `cancelled` is split
 * out so we can stay quiet when the rider just dismisses the sheet —
 * showing an error toast in that case would be obnoxious.
 */
export async function pickAndParseRoute(): Promise<TripImportOutcome> {
  let response;
  try {
    const results = await pick({
      mode: "import",
      // Both GPX and KML present as either MIME or file-extension varieties
      // depending on the OEM picker. Listing both keeps Android happy
      // without Apple-side restrictions (iOS uses UTType identifiers via
      // `types.allFiles` fallback).
      type: [
        "application/gpx+xml",
        "application/vnd.google-earth.kml+xml",
        types.allFiles,
      ],
      allowMultiSelection: false,
    });
    response = results[0];
  } catch (err) {
    if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
      return { ok: false, cancelled: true };
    }
    return {
      ok: false,
      cancelled: false,
      error: err instanceof Error ? err.message : "Could not open file picker.",
    };
  }

  if (!response || !response.uri) {
    return { ok: false, cancelled: true };
  }

  const filename = response.name ?? "imported.gpx";
  if (!isSupportedFilename(filename, response.type)) {
    return {
      ok: false,
      cancelled: false,
      error: "Unsupported file type. Pick a .gpx or .kml file.",
    };
  }

  // Pre-flight on file size so a malformed or 100MB track can't OOM the
  // RN bridge during readFile. The 10MB ceiling matches what the
  // backend's `/rides/import` accepts so import behaviour is consistent
  // across surfaces.
  try {
    const stat = await RNFS.stat(decodeURI(response.uri));
    if (typeof stat.size === "number" && stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        cancelled: false,
        error: "File is larger than 10 MB. Trim the GPX and try again.",
      };
    }
  } catch {
    // stat() can fail on content:// URIs that haven't been copied to a
    // local path yet — fall through to readFile and let it surface a
    // more specific error if the URI really is unusable.
  }

  let text: string;
  try {
    text = await RNFS.readFile(response.uri, "utf8");
  } catch (err) {
    return {
      ok: false,
      cancelled: false,
      error: err instanceof Error ? err.message : "Could not read the file.",
    };
  }

  const parsed = parseImportedRoute(text, filename);
  if (!parsed.ok) {
    return { ok: false, cancelled: false, error: parsed.error };
  }
  return { ok: true, route: parsed.route, filename };
}

function isSupportedFilename(name: string, mime: string | null): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".gpx") || lower.endsWith(".kml")) return true;
  if (!mime) return false;
  const mimeLower = mime.toLowerCase();
  return (
    mimeLower.includes("gpx") ||
    mimeLower.includes("google-earth") ||
    mimeLower.includes("kml")
  );
}

/**
 * Build the request body the backend expects from a parsed
 * `ImportedRoute`. Splitting this from `pickAndParseRoute` lets tests
 * exercise the conversion without driving the file picker, and lets
 * callers preview the parsed route to the rider before posting.
 */
export function routeToImportRequest(
  route: ImportedRoute,
  title: string,
  region?: string,
): {
  title: string;
  region?: string;
  source_format: "gpx" | "kml";
  geometry: Array<{ lat: number; lng: number }>;
  waypoints?: Array<{ lat: number; lng: number; name?: string }>;
} {
  return {
    title: title.trim() || route.name,
    region: region?.trim() || undefined,
    source_format: route.sourceFormat,
    geometry: route.points.map(([lng, lat]) => ({ lat, lng })),
    waypoints:
      route.waypoints.length > 0
        ? route.waypoints.map((w) => ({
            lat: w.lat,
            lng: w.lng,
            name: w.name,
          }))
        : undefined,
  };
}
