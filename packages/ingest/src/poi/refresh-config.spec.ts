import { DEFAULT_REGIONS } from "./regions.js";
import {
  FSQ_CATALOG_ENDPOINT,
  FSQ_CATEGORY_PREFILTER,
  FSQ_PLACES_TABLE,
  GEOFABRIK_SLUGS,
  POI_TAGS_FILTER_EXPRESSIONS,
  bboxArg,
  buildFsqExtractSql,
  geofabrikUrl,
  resolveFsqRefreshConfig,
  resolvePoiRefreshConfig,
} from "./refresh-config.js";

const CZ = {
  code: "CZ",
  bbox: { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 },
};

describe("poi-refresh.config", () => {
  it("has a Geofabrik slug for every configured region, and no stray slugs (#976 drift guard)", () => {
    const missing = DEFAULT_REGIONS.filter((r) => !GEOFABRIK_SLUGS[r.code]).map(
      (r) => r.code,
    );
    expect(missing).toEqual([]);

    const codes = new Set(DEFAULT_REGIONS.map((r) => r.code));
    const stray = Object.keys(GEOFABRIK_SLUGS).filter((c) => !codes.has(c));
    expect(stray).toEqual([]);
  });

  it("builds the europe/<slug>-latest.osm.pbf URL; null for an unknown code", () => {
    expect(geofabrikUrl("CZ")).toBe(
      "https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf",
    );
    expect(geofabrikUrl("ZZ")).toBeNull();
  });

  it("bboxArg is minLng,minLat,maxLng,maxLat — osmium extract -b order", () => {
    expect(
      bboxArg({ minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 }),
    ).toBe("12.09,48.55,18.86,51.06");
  });

  it("tags-filter is the §7 superset (fast_food, ice cream, camp_site, rest areas)", () => {
    const joined = POI_TAGS_FILTER_EXPRESSIONS.join(" ");
    expect(joined).toContain(
      "amenity=fuel,restaurant,cafe,fast_food,ice_cream",
    );
    expect(joined).toContain("camp_site");
    expect(joined).toContain("viewpoint");
    expect(joined).toContain("highway=rest_area,services");
    expect(joined).toContain("shop=ice_cream");
  });

  describe("resolvePoiRefreshConfig", () => {
    it("is disabled with all regions by default", () => {
      const cfg = resolvePoiRefreshConfig({
        TARMOTO_OSM_POI_IMPORT_DIR: "/data",
      });

      expect(cfg.enabled).toBe(false);
      expect(cfg.targetDir).toBe("/data");
      expect(cfg.regions).toHaveLength(DEFAULT_REGIONS.length);
    });

    it("enables on TARMOTO_OSM_POI_REFRESH_ENABLED=true and narrows to (case-insensitive) TARMOTO_OSM_POI_IMPORT_REGIONS", () => {
      const cfg = resolvePoiRefreshConfig({
        TARMOTO_OSM_POI_REFRESH_ENABLED: "true",
        TARMOTO_OSM_POI_IMPORT_DIR: "/data",
        TARMOTO_OSM_POI_IMPORT_REGIONS: "cz, sk , AT",
      });

      expect(cfg.enabled).toBe(true);
      // validated, deduped, upper-cased (case-insensitive, whitespace-trimmed)
      expect(cfg.regions.map((r) => r.code)).toEqual(["CZ", "SK", "AT"]);
    });

    it("targetDir is null when TARMOTO_OSM_POI_IMPORT_DIR is unset", () => {
      expect(resolvePoiRefreshConfig({}).targetDir).toBeNull();
    });

    it("fails fast on an unknown region code instead of silently dropping it (#976 review)", () => {
      expect(() =>
        resolvePoiRefreshConfig({ TARMOTO_OSM_POI_IMPORT_REGIONS: "CZ,ZZ" }),
      ).toThrow(/unknown region "ZZ"/);
    });

    it("rejects a POI dir that collides with the road routing dir (both write <code>.osm) — the guard also fires on the POI path, which may run first", () => {
      expect(() =>
        resolvePoiRefreshConfig({
          TARMOTO_OSM_POI_IMPORT_DIR: "/data/routing",
          TARMOTO_OSM_ROAD_ROUTING_DIR: "/data/routing/",
        }),
      ).toThrow(/must differ from TARMOTO_OSM_POI_IMPORT_DIR/);
    });

    it("allows a POI dir distinct from the routing dir", () => {
      expect(() =>
        resolvePoiRefreshConfig({
          TARMOTO_OSM_POI_IMPORT_DIR: "/data/poi-extracts",
          TARMOTO_OSM_ROAD_ROUTING_DIR: "/data/routing",
        }),
      ).not.toThrow();
    });
  });

  describe("resolveFsqRefreshConfig", () => {
    it("is disabled with a null token/dir and all regions by default", () => {
      const cfg = resolveFsqRefreshConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.token).toBeNull();
      expect(cfg.targetDir).toBeNull();
      expect(cfg.regions).toHaveLength(DEFAULT_REGIONS.length);
    });

    it("reads the token + dir and narrows to (case-insensitive) TARMOTO_FSQ_POI_IMPORT_REGIONS", () => {
      const cfg = resolveFsqRefreshConfig({
        TARMOTO_FSQ_POI_REFRESH_ENABLED: "true",
        TARMOTO_FSQ_POI_TOKEN: "  tok-123  ",
        TARMOTO_FSQ_POI_IMPORT_DIR: "/fsq",
        TARMOTO_FSQ_POI_IMPORT_REGIONS: "cz, sk",
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.token).toBe("tok-123"); // trimmed
      expect(cfg.targetDir).toBe("/fsq");
      expect(cfg.regions.map((r) => r.code)).toEqual(["CZ", "SK"]);
    });

    it("uses the FSQ env, independent of the OSM region/dir vars", () => {
      const cfg = resolveFsqRefreshConfig({
        TARMOTO_OSM_POI_IMPORT_DIR: "/osm",
        TARMOTO_OSM_POI_IMPORT_REGIONS: "DE",
        TARMOTO_FSQ_POI_IMPORT_DIR: "/fsq",
        TARMOTO_FSQ_POI_IMPORT_REGIONS: "CZ",
      });
      expect(cfg.targetDir).toBe("/fsq");
      expect(cfg.regions.map((r) => r.code)).toEqual(["CZ"]);
    });

    it("fails fast on an unknown FSQ region code", () => {
      expect(() =>
        resolveFsqRefreshConfig({ TARMOTO_FSQ_POI_IMPORT_REGIONS: "CZ,ZZ" }),
      ).toThrow(/unknown region "ZZ"/);
    });
  });

  describe("buildFsqExtractSql", () => {
    const sql = buildFsqExtractSql({
      token: "tok-abc",
      region: CZ,
      outPath: "/fsq/cz.fsq.jsonl.part",
      tempDir: "/work",
    });

    it("selects the FsqPlaceRow field list + comma-joined category arrays", () => {
      expect(sql).toContain("fsq_place_id, name, latitude, longitude");
      expect(sql).toContain(
        "array_to_string(fsq_category_ids, ',')    AS category_ids",
      );
      expect(sql).toContain(
        "array_to_string(fsq_category_labels, ',') AS category_labels",
      );
      expect(sql).toContain(
        "tel, website, address, locality, postcode, country",
      );
    });

    it("attaches the static catalog + queries the OS Places table", () => {
      expect(sql).toContain(`ENDPOINT '${FSQ_CATALOG_ENDPOINT}'`);
      expect(sql).toContain(`FROM ${FSQ_PLACES_TABLE}`);
    });

    it("scopes by ISO-2 country, bbox, open places, and the category superset", () => {
      expect(sql).toContain("AND country = 'CZ'");
      expect(sql).toContain("longitude BETWEEN 12.09 AND 18.86");
      expect(sql).toContain("latitude  BETWEEN 48.55 AND 51.06");
      expect(sql).toContain("date_closed IS NULL");
      expect(sql).toContain(FSQ_CATEGORY_PREFILTER);
    });

    it("writes NDJSON to the given out path via COPY (FORMAT json)", () => {
      expect(sql).toContain("TO '/fsq/cz.fsq.jsonl.part' (FORMAT json)");
    });

    it("embeds the token as a secret and sets the spill dir when given", () => {
      expect(sql).toContain("TOKEN 'tok-abc'");
      expect(sql).toContain("SET temp_directory='/work'");
    });

    it("omits temp_directory when no tempDir is given", () => {
      const noTemp = buildFsqExtractSql({
        token: "t",
        region: CZ,
        outPath: "/x.part",
      });
      expect(noTemp).not.toContain("temp_directory");
    });

    it("escapes a single quote in the token to keep it a safe literal", () => {
      const injected = buildFsqExtractSql({
        token: "a'b",
        region: CZ,
        outPath: "/x.part",
      });
      // Doubled inside the literal — never terminates the string early.
      expect(injected).toContain("TOKEN 'a''b'");
    });
  });
});
