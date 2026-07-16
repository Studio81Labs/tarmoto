import { parseRegions, type PoiImportRegion } from "./regions.js";

/**
 * Config for the automated extract refresh (#976) — the "fetch" half of the
 * offline POI pipeline, for BOTH bulk sources. A scheduled `apps/ingest`
 * container (see the runbook; the retired standalone
 * `apps/backend/Dockerfile.poi-refresh` one-shot container's osmium/duckdb
 * role is folded into this image) writes fresh per-region extracts to the
 * shared import volume BEFORE the import cron reads them, so the store mirrors
 * CURRENT data instead of re-importing a static file:
 *  - **OSM** (weekly): download the per-country Geofabrik PBF, `osmium`-filter to
 *    the POI tag set, clip to each region's bbox → `<code>.osm`.
 *  - **FSQ** (monthly): a token-gated DuckDB pull from the Foursquare OS Places
 *    Iceberg catalog, filtered to each region's country + bbox + POI categories
 *    → `<code>.fsq.jsonl`.
 *
 * Region set + target dir are shared with the importer (same
 * `TARMOTO_{POI,FSQ}_IMPORT_REGIONS` / `_DIR`), and bboxes come straight from
 * `DEFAULT_REGIONS`, so the clip box can never drift from the one the importer's
 * stale-by-absence tombstoning is bounded by (#850). The FSQ token is the only
 * environment-derived value in the DuckDB SQL and is confined to this container
 * (it never reaches the backend/worker, which read only the credential-free
 * extract files).
 */

/** Geofabrik hosts all 17 coverage countries under its `europe/` tree. */
export const GEOFABRIK_BASE_URL = "https://download.geofabrik.de/europe";

/**
 * `DEFAULT_REGIONS` code → Geofabrik country slug. Geofabrik-specific naming
 * (e.g. `bosnia-herzegovina`, `macedonia`, `kosovo`), so it lives here rather
 * than on the importer's region config. A wrong slug surfaces as a clear 404 on
 * download. Every `DEFAULT_REGIONS` code must appear here — enforced by
 * `poi-refresh.config.spec`.
 */
export const GEOFABRIK_SLUGS: Readonly<Record<string, string>> = {
  CZ: "czech-republic",
  SK: "slovakia",
  PL: "poland",
  DE: "germany",
  AT: "austria",
  IT: "italy",
  SI: "slovenia",
  HR: "croatia",
  BA: "bosnia-herzegovina",
  RS: "serbia",
  ME: "montenegro",
  MK: "macedonia",
  AL: "albania",
  XK: "kosovo",
  BG: "bulgaria",
  RO: "romania",
  GR: "greece",
};

/**
 * `osmium tags-filter` expressions — the §7 POI tag set (fuel, food incl.
 * `fast_food` + ice cream, accommodation, viewpoints, rest areas). MUST stay a
 * superset of what the importer's OSM parser recognizes, or a refreshed extract
 * would silently drop POIs the importer would otherwise keep — kept verbatim in
 * lockstep with the runbook's worked example. `nwr/` = nodes, ways AND relations
 * (hotels / campsites / rest areas are often mapped as areas, not just points).
 */
export const POI_TAGS_FILTER_EXPRESSIONS: readonly string[] = [
  "nwr/amenity=fuel,restaurant,cafe,fast_food,ice_cream",
  "nwr/tourism=hotel,guest_house,motel,hostel,chalet,apartment,camp_site,viewpoint",
  "nwr/highway=rest_area,services",
  "nwr/shop=ice_cream",
];

/** Geofabrik download URL for a region's country PBF (null if no slug). */
export function geofabrikUrl(code: string): string | null {
  const slug = GEOFABRIK_SLUGS[code];
  return slug ? `${GEOFABRIK_BASE_URL}/${slug}-latest.osm.pbf` : null;
}

/** `osmium extract -b` bbox arg: `minLng,minLat,maxLng,maxLat`. */
export function bboxArg(bbox: PoiImportRegion["bbox"]): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

function boolEnv(value: string | undefined): boolean {
  return (value ?? "false").trim().toLowerCase() === "true";
}

export interface PoiRefreshConfig {
  /** Gate — off unless `TARMOTO_POI_REFRESH_ENABLED=true`. */
  enabled: boolean;
  /**
   * Directory the fresh `<code>.osm` files are written to — the SAME
   * `TARMOTO_POI_IMPORT_DIR` the importer reads. `null` when unset (the script
   * fails fast: there's nowhere to write).
   */
  targetDir: string | null;
  /**
   * Regions to refresh: `DEFAULT_REGIONS` narrowed by
   * `TARMOTO_POI_IMPORT_REGIONS` (default all). Shares the importer's region env
   * so the refresh and the import always target the same set; an unknown code
   * fails fast (like the importer's `parseRegions`) rather than being silently
   * dropped.
   */
  regions: readonly PoiImportRegion[];
}

/**
 * Resolve the OSM refresh config from the environment — standalone (no Nest DI),
 * so the refresh container needn't boot the app. Region validation is shared
 * with the importer (`parseRegions`): an unknown `TARMOTO_POI_IMPORT_REGIONS`
 * code fails fast rather than being silently dropped (#976 review) — otherwise
 * the scheduled task would exit green having refreshed nothing while the import
 * keeps reusing stale files.
 */
export function resolvePoiRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoiRefreshConfig {
  const dir = env.TARMOTO_POI_IMPORT_DIR?.trim();
  return {
    enabled: boolEnv(env.TARMOTO_POI_REFRESH_ENABLED),
    targetDir: dir ? dir : null,
    regions: parseRegions(
      env.TARMOTO_POI_IMPORT_REGIONS,
      "TARMOTO_POI_IMPORT_REGIONS",
    ),
  };
}

// ---------------------------------------------------------------------------
// FSQ (Foursquare OS Places) automated refresh (#976) — the DuckDB half.
// ---------------------------------------------------------------------------

/**
 * FSQ OS Places Iceberg REST catalog endpoint. STATIC — the Portal's connect
 * recipe is fixed and only the access token rotates (~monthly), so this and the
 * table name are hardcoded and just the token comes from the environment.
 */
export const FSQ_CATALOG_ENDPOINT =
  "https://catalog.h3-hub.foursquare.com/iceberg";

/** Fully-qualified OS Places table inside the attached `places` catalog. */
export const FSQ_PLACES_TABLE = "places.datasets.places_os";

/**
 * Coarse category prefilter pushed into the DuckDB scan (a case-insensitive
 * regex over the joined `fsq_category_labels`). It MUST stay a SUPERSET of the
 * labels the backend classifier (`fsq-poi-categories.ts`) matches: loose is fine
 * (the classifier drops false positives downstream), but a MISS would drop rows
 * the importer would keep — and later tombstone them as absent. Kept verbatim in
 * lockstep with the runbook's worked example and the classifier's label set.
 */
export const FSQ_CATEGORY_PREFILTER =
  "restaurant|caf|coffee|tea room|tea house|food|ice cream|gas|petrol|fuel|" +
  "charging|lookout|viewpoint|overlook|rest area|hotel|motel|hostel|inn|guest|" +
  "b&b|breakfast|apartment|camp|rv park|caravan|resort|cottage|chalet|cabin|" +
  "vacation|holiday|rental";

/**
 * DuckDB memory ceiling for a per-country FSQ scan — bounds RAM so a large
 * region spills to `temp_directory` instead of getting OOM-killed (the osmium
 * OOM lesson, #976 ops).
 */
export const FSQ_DUCKDB_MEMORY_LIMIT = "2GB";

export interface FsqRefreshConfig {
  /** Gate — off unless `TARMOTO_FSQ_REFRESH_ENABLED=true`. */
  enabled: boolean;
  /**
   * FSQ Places Portal access token (`TARMOTO_FSQ_TOKEN`). Confined to THIS
   * extractor container — it never reaches the backend/worker, which read only
   * the credential-free `.fsq.jsonl` files. `null` when unset (the script fails
   * fast). Short-lived (~monthly), so an operator rotates it each refresh.
   */
  token: string | null;
  /**
   * Directory the fresh `<code>.fsq.jsonl` files are written to — the SAME
   * `TARMOTO_FSQ_IMPORT_DIR` the importer reads. `null` when unset (the script
   * fails fast: nowhere to write). Independent of the OSM dir.
   */
  targetDir: string | null;
  /**
   * Regions to refresh: `DEFAULT_REGIONS` narrowed by
   * `TARMOTO_FSQ_IMPORT_REGIONS` (default all); an unknown code fails fast, like
   * the importer. Independent of the OSM region list.
   */
  regions: readonly PoiImportRegion[];
}

/**
 * Resolve the FSQ refresh config from the environment — standalone (no Nest DI).
 * Mirrors {@link resolvePoiRefreshConfig} but for the FSQ source's own env
 * (`TARMOTO_FSQ_*`) plus the token.
 */
export function resolveFsqRefreshConfig(
  env: NodeJS.ProcessEnv = process.env,
): FsqRefreshConfig {
  const token = env.TARMOTO_FSQ_TOKEN?.trim();
  const dir = env.TARMOTO_FSQ_IMPORT_DIR?.trim();
  return {
    enabled: boolEnv(env.TARMOTO_FSQ_REFRESH_ENABLED),
    token: token ? token : null,
    targetDir: dir ? dir : null,
    regions: parseRegions(
      env.TARMOTO_FSQ_IMPORT_REGIONS,
      "TARMOTO_FSQ_IMPORT_REGIONS",
    ),
  };
}

/**
 * Single-quote a value as a DuckDB SQL string literal (doubling embedded
 * quotes). The token is the only environment-derived value interpolated into the
 * SQL; escaping keeps a stray quote from breaking — or injecting into — the
 * script. The `outPath` is escaped the same way for good measure (it derives
 * from `TARMOTO_FSQ_IMPORT_DIR`).
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface FsqExtractSqlParams {
  /** FSQ Places Portal token — embedded in `CREATE SECRET` (via STDIN, never argv). */
  token: string;
  /** Region to pull — supplies the ISO-2 country filter + the bbox clip. */
  region: PoiImportRegion;
  /** Destination path for the NDJSON (the COPY `TO` target — our atomic temp). */
  outPath: string;
  /** DuckDB spill dir (`temp_directory`) so a big scan spills instead of OOMing. */
  tempDir?: string;
}

/**
 * Build the full DuckDB script for one region's FSQ extract: load the
 * httpfs/iceberg extensions, create the token secret, attach the OS Places
 * Iceberg catalog, and COPY the filtered, category-prefiltered rows to `outPath`
 * as NDJSON. Fed to `duckdb` on STDIN so the token never lands in the process
 * arg list. The SELECT's field list + aliases match `FsqPlaceRow`
 * (`fsq-poi-categories.ts`), so the importer parses the output unchanged;
 * `(FORMAT json)` writes newline-delimited JSON (one row per line).
 */
export function buildFsqExtractSql(params: FsqExtractSqlParams): string {
  const { token, region, outPath, tempDir } = params;
  const { minLng, minLat, maxLng, maxLat } = region.bbox;
  const pragmas = [
    "INSTALL httpfs;",
    "LOAD httpfs;",
    "INSTALL iceberg;",
    "LOAD iceberg;",
    `SET memory_limit=${sqlLiteral(FSQ_DUCKDB_MEMORY_LIMIT)};`,
  ];
  if (tempDir) pragmas.push(`SET temp_directory=${sqlLiteral(tempDir)};`);
  return `${pragmas.join("\n")}
CREATE SECRET iceberg_secret (TYPE ICEBERG, TOKEN ${sqlLiteral(token)});
ATTACH 'places' AS places (
  TYPE iceberg,
  SECRET iceberg_secret,
  ENDPOINT ${sqlLiteral(FSQ_CATALOG_ENDPOINT)}
);
COPY (
  SELECT
    fsq_place_id, name, latitude, longitude,
    array_to_string(fsq_category_ids, ',')    AS category_ids,
    array_to_string(fsq_category_labels, ',') AS category_labels,
    tel, website, address, locality, postcode, country
  FROM ${FSQ_PLACES_TABLE}
  WHERE date_closed IS NULL
    -- places_os is GLOBAL, and a bbox overlaps neighbours at the borders;
    -- scope by ISO-2 country too or their POIs import mis-owned (wrong
    -- import_region + tombstone scope). Region code == its DEFAULT_REGIONS /
    -- ISO-2 code.
    AND country = ${sqlLiteral(region.code)}
    AND longitude BETWEEN ${minLng} AND ${maxLng}
    AND latitude  BETWEEN ${minLat} AND ${maxLat}
    -- Coarse superset of the classifier's labels — a miss would drop kept rows.
    AND len(list_filter(fsq_category_labels,
        x -> regexp_matches(lower(x), ${sqlLiteral(FSQ_CATEGORY_PREFILTER)}))) > 0
) TO ${sqlLiteral(outPath)} (FORMAT json);
`;
}
