/**
 * `highway=*` values imported as drivable roads (#781, Sub-project B).
 *
 * SINGLE SOURCE OF TRUTH for two consumers that must never drift:
 *  - the backend importer's `isDrivableHighway` gate (`osm-tags.ts`), and
 *  - the ingest road-extract producer's `osmium tags-filter` expression
 *    (`road-refresh-config.ts`).
 *
 * If these diverged, the extract could silently drop a class the importer keeps
 * — a permanent coverage gap that looks like "no roads there". The extract
 * filter is a deliberate SUPERSET: the importer still applies finer
 * access/service gating downstream; this list only makes the coarse
 * "is this way a road at all?" cut. `track` is included (forest/agri roads
 * riders use); footways / cycleways / paths are excluded.
 */
export const DRIVABLE_HIGHWAYS: readonly string[] = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "track",
];
