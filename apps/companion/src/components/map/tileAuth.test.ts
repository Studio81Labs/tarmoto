import { describe, expect, it } from "vitest";
import { createTileTransformRequest } from "./tileAuth";

const TILE_BASE = "https://api.tarmoto.app/api/v1/roads/tiles/";
const withToken = createTileTransformRequest(TILE_BASE, () => "tok-123");
const withoutToken = createTileTransformRequest(TILE_BASE, () => null);

describe("createTileTransformRequest (#1279)", () => {
  it("appends the credential to a backend tile request", () => {
    expect(withToken(`${TILE_BASE}13/4424/2782.mvt?layers=quality`)).toEqual({
      url: `${TILE_BASE}13/4424/2782.mvt?layers=quality&tile_token=tok-123`,
    });
  });

  it("opens the query string when the URL has none", () => {
    expect(withToken(`${TILE_BASE}13/4424/2782.mvt`)).toEqual({
      url: `${TILE_BASE}13/4424/2782.mvt?tile_token=tok-123`,
    });
  });

  it("url-encodes the credential", () => {
    const transform = createTileTransformRequest(TILE_BASE, () => "a+b/c=d");

    expect(transform(`${TILE_BASE}13/1/1.mvt`)).toEqual({
      url: `${TILE_BASE}13/1/1.mvt?tile_token=a%2Bb%2Fc%3Dd`,
    });
  });

  // The acceptance criterion of #1279: no credential may ever reach a
  // third-party tile or style host. MapLibre routes the basemap style,
  // sprites, glyphs, its tiles, and the aerial raster through this same hook.
  describe("never credentials a third-party host", () => {
    it.each([
      ["basemap style", "https://tiles.openfreemap.org/styles/liberty"],
      ["basemap sprite", "https://tiles.openfreemap.org/sprites/ofm_f384/ofm"],
      [
        "basemap glyphs",
        "https://tiles.openfreemap.org/fonts/noto_sans_regular/0-255.pbf",
      ],
      [
        "basemap tiles",
        "https://tiles.openfreemap.org/planet/14/8800/5360.pbf",
      ],
      [
        "aerial raster",
        "https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/14/5360/8800",
      ],
    ])("leaves the %s request untouched", (_label, url) => {
      expect(withToken(url)).toBeUndefined();
    });

    it("does not match a third-party URL that merely contains the tile base", () => {
      // A `includes`-style predicate would credential this. The prefix test is
      // what makes an open-redirect-shaped style URL a non-event.
      expect(
        withToken(`https://evil.example/proxy?to=${TILE_BASE}13/1/1.mvt`),
      ).toBeUndefined();
    });

    it("does not match a look-alike host that prefixes the api hostname", () => {
      expect(
        withToken("https://api.tarmoto.app.evil.example/api/v1/roads/tiles/"),
      ).toBeUndefined();
    });

    it("does not match the offline file:// template mobile uses", () => {
      expect(
        withToken("file:///docs/offline-tiles/region/13/1/1.mvt"),
      ).toBeUndefined();
    });
  });

  it("leaves backend tile requests unchanged when there is no credential", () => {
    // Signed-out visitors, and the window between sign-in and the first mint:
    // the tile is fetched anonymously and the backend clamps to the free tier
    // rather than the request failing.
    expect(
      withoutToken(`${TILE_BASE}13/4424/2782.mvt?layers=quality`),
    ).toBeUndefined();
  });

  it("reads the credential per request, so rotation needs no re-init", () => {
    // `transformRequest` is an init-time-only Map option; a captured value
    // would pin the map to whichever token existed when it was constructed.
    let token = "first";
    const transform = createTileTransformRequest(TILE_BASE, () => token);

    expect(transform(`${TILE_BASE}13/1/1.mvt`)?.url).toContain(
      "tile_token=first",
    );
    token = "second";
    expect(transform(`${TILE_BASE}13/1/1.mvt`)?.url).toContain(
      "tile_token=second",
    );
  });
});
