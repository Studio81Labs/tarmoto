/**
 * Hazard-report deep-link helpers — US-17 follow-up (#343).
 *
 * The Android shortcuts manifest (`res/xml/shortcuts.xml`) emits
 * `tarmoto://hazard/report?preselectedType=<type>` when the Google
 * Assistant matches a "report a pothole" voice query. React
 * Navigation's linking config (in `RootNavigator.tsx`) parses the
 * URL into route params; this module owns the validation step so
 * the screen never receives a hazard type the rest of the app
 * doesn't recognise.
 *
 * Why a dedicated service instead of an inline arrow:
 *   - The validator runs at the linking-config layer (top of the
 *     app) and at the screen layer (defensive read of the route
 *     param). Centralising here keeps both call sites honest about
 *     the canonical hazard-type vocabulary.
 *   - Source of truth is `HAZARD_TYPES` from `@tarmoto/shared`,
 *     which the backend / OpenAPI / companion all share. The
 *     Assistant inventory in `arrays.xml` mirrors those values; if
 *     a future hazard type lands in shared but the inventory
 *     forgets to add it, this guard still rejects the unknown
 *     value rather than punching it through to the screen.
 */

import { HAZARD_TYPES } from "@tarmoto/shared";
import type { HazardType } from "@/types";

/**
 * Coerce a query-string value into a canonical `HazardType`. The
 * raw input from React Navigation's linking parser is always a
 * string when the param is present, but TypeScript types it as
 * `string` (no narrower guarantee), and the linking layer hands the
 * value through unchanged regardless of source — a malformed deep
 * link or a hostile URL handler could land arbitrary text here.
 *
 * Returns the canonical type when the input matches one of
 * `HAZARD_TYPES` exactly. Anything else (including empty strings,
 * unexpected casing, or values that fell out of the synonym
 * mapping) returns `undefined`, which the HazardReport screen
 * treats as "no preselection" — the rider lands on the type-picker
 * grid as if they tapped the FAB without a preselection.
 *
 * Case-insensitive matching covers the rare path where the
 * Assistant emits a non-canonical casing (the inline inventory
 * uses lower-case, so the match is normally exact, but the OS-
 * level shortcut surface accepts custom user phrasing). Whitespace
 * is trimmed for the same reason.
 */
export function parseHazardTypeParam(
  value: string | undefined,
): HazardType | undefined {
  if (typeof value !== "string") return undefined;
  // Hazard deep-link values are canonical API enum tokens.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0) return undefined;
  return (HAZARD_TYPES as readonly string[]).includes(normalised)
    ? (normalised as HazardType)
    : undefined;
}
