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
import {
  parseImportedRoute,
  type ImportedRoute,
  type ImportErrorCode,
} from "@tarmoto/shared";
import { translate, type EnglishMessageKey, type Translate } from "@/i18n";
import { isFeatureKillSwitchActive } from "@/services/systemSwitchCache";

export type TripImportOutcome =
  | { ok: true; route: ImportedRoute; filename: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const IMPORT_ERROR_MESSAGES = {
  empty_file: "File is empty.",
  unsupported_format: "Unsupported file format. Upload a GPX or KML file.",
  invalid_xml: "File is not valid XML.",
  gpx_without_route: "GPX file has no track or route points.",
  kml_without_linestring: "KML file has no LineString coordinates.",
  too_few_points: "Route needs at least two points.",
} as const satisfies Record<ImportErrorCode, EnglishMessageKey>;

export function importErrorMessage(
  error: ImportErrorCode,
  t: Translate = translate,
): string {
  return t(IMPORT_ERROR_MESSAGES[error]);
}

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
      error: translate("Could not open file picker."),
    };
  }

  if (!response || !response.uri) {
    return { ok: false, cancelled: true };
  }

  // Don't synthesise a `.gpx` fallback when the picker omits the name —
  // some Android providers return URI + MIME but no display name, and an
  // extension-tagged default would force every such file down the GPX
  // detection path even when the MIME (or the body itself) clearly says
  // KML. An extension-less stem makes `parseImportedRoute` fall through
  // to its content sniff, which keys on `<gpx` vs `<kml`.
  const filename = response.name ?? "imported";
  if (!isSupportedFilename(filename, response.type)) {
    return {
      ok: false,
      cancelled: false,
      error: translate("Unsupported file type. Pick a .gpx or .kml file."),
    };
  }

  // Pre-flight on file size so a malformed or 100MB track can't OOM the
  // RN bridge during readFile. The 10MB ceiling matches what the
  // backend's `/rides/import` accepts so import behaviour is consistent
  // across surfaces.
  //
  // We feed the picker URI to `stat` and `readFile` verbatim — using
  // `decodeURI` on one but not the other (an earlier draft) made the
  // size guard inspect a different path than the read on URIs with
  // percent-encoded characters, which silently bypassed the 10 MB cap
  // when stat failed. If stat genuinely can't resolve the URI (e.g. a
  // content:// scheme that needs RNFS's `copyFileAssets` first) we
  // size-check via the readFile result instead so a malicious or
  // pathological file can't slip past in either path.
  let prevalidated = false;
  try {
    const stat = await RNFS.stat(response.uri);
    // RNFS exposes `size` as a string in this codebase (see
    // `offlineRegions.ts` for the established pattern). The previous
    // `typeof stat.size === "number"` guard was always false in
    // production, so the cap was effectively bypassed and the read-time
    // fallback was the only thing protecting against OOM. `Number()`
    // coerces the string; `Number.isFinite` rejects empty strings,
    // null, and other parser failures.
    const sizeBytes = Number(stat.size);
    if (Number.isFinite(sizeBytes) && sizeBytes >= 0) {
      if (sizeBytes > MAX_FILE_BYTES) {
        return {
          ok: false,
          cancelled: false,
          error: translate(
            "File is larger than {sizeMb, number} MB. Trim the GPX and try again.",
            { sizeMb: 10 },
          ),
        };
      }
      prevalidated = true;
    }
  } catch {
    // stat() can fail on content:// URIs that haven't been copied to a
    // local path yet — fall through to the readFile size check below.
  }

  let text: string;
  try {
    text = await RNFS.readFile(response.uri, "utf8");
  } catch {
    return {
      ok: false,
      cancelled: false,
      error: translate("Could not read the file."),
    };
  }

  // Belt-and-suspenders for the case where stat() couldn't size the
  // file: a UTF-8 decoded string ≥ MAX_FILE_BYTES is a clear sign the
  // payload would have been rejected at the stat stage if we'd been
  // able to inspect it. `Blob` isn't available in the RN runtime, so
  // string length is the closest proxy.
  if (!prevalidated && text.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      cancelled: false,
      error: translate(
        "File is larger than {sizeMb, number} MB. Trim the GPX and try again.",
        { sizeMb: 10 },
      ),
    };
  }

  // Recheck the `gpx_import` kill switch right before handing untrusted file
  // bytes to the parser: the operator may have flipped it off during the async
  // pick / stat / read, and parsing the file is itself the parser-vulnerability
  // surface the switch exists to close. Silent abort (cancelled) — no error.
  if (!isFeatureKillSwitchActive("gpx_import")) {
    return { ok: false, cancelled: true };
  }

  const parsed = parseImportedRoute(text, filename);
  if (!parsed.ok) {
    return {
      ok: false,
      cancelled: false,
      error: importErrorMessage(parsed.error),
    };
  }
  return { ok: true, route: parsed.route, filename };
}

function isSupportedFilename(name: string, mime: string | null): boolean {
  // File extensions and MIME types are ASCII machine tokens.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  const lower = name.toLowerCase();
  if (lower.endsWith(".gpx") || lower.endsWith(".kml")) return true;
  if (!mime) return false;
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
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
  const trimmedRegion = region?.trim();
  return {
    title: title.trim() || route.name,
    ...(trimmedRegion ? { region: trimmedRegion } : {}),
    source_format: route.sourceFormat,
    geometry: route.points.map(([lng, lat]) => ({ lat, lng })),
    ...(route.waypoints.length > 0
      ? {
          waypoints: route.waypoints.map((w) => ({
            lat: w.lat,
            lng: w.lng,
            ...(w.name !== undefined ? { name: w.name } : {}),
          })),
        }
      : {}),
  };
}
