/**
 * Origin scoping for tile credentials (#1279).
 *
 * The acceptance criterion of the issue is that no credential ever reaches a
 * third-party tile or style host — the basemap is OpenFreeMap's. These are the
 * pure predicates both credential channels are built on, so they are where
 * that property is pinned.
 */

import {
  authHeadersForTileUrl,
  backendTileUrlBase,
  backendTileUrlPattern,
} from "../tileUrls";

const API = "https://api.tarmoto.app";
const TOKEN = "access-token-123";

describe("backendTileUrlBase", () => {
  it("is the prefix every backend tile URL is built from", () => {
    expect(backendTileUrlBase(API)).toBe(
      "https://api.tarmoto.app/api/v1/roads/tiles/",
    );
  });
});

describe("backendTileUrlPattern", () => {
  const pattern = backendTileUrlPattern(API);

  it("is anchored, because both native bridges match it as a substring", () => {
    // Android uses `Regex.containsMatchIn` and iOS `NSRegularExpression`, so an
    // unanchored pattern would also credential a foreign URL that merely
    // CONTAINS our base.
    expect(pattern.startsWith("^")).toBe(true);
  });

  it("escapes the host so dots are not wildcards", () => {
    expect(pattern).toContain("api\\.tarmoto\\.app");
  });

  it("travels as a plain, valid regex source string", () => {
    // `TransformRequestManager.toRegexString` THROWS on a RegExp carrying
    // flags, so the pattern must be handed over as a bare source string — and
    // it still has to compile, since both native sides build a real regex.
    expect(typeof pattern).toBe("string");
    expect(() => new RegExp(pattern)).not.toThrow();
  });

  it("matches backend QUALITY tile URLs and nothing else", () => {
    const re = new RegExp(pattern);

    expect(
      re.test(`${API}/api/v1/roads/tiles/13/4424/2782.mvt?layers=quality`),
    ).toBe(true);
    expect(re.test("https://tiles.openfreemap.org/planet/13/1/1.pbf")).toBe(
      false,
    );
    // The substring case the anchor exists for.
    expect(
      re.test(
        `https://tiles.openfreemap.org/x?to=${API}/api/v1/roads/tiles/13/1/1.mvt?layers=quality`,
      ),
    ).toBe(false);
    // A look-alike host that merely starts with ours.
    expect(
      re.test(
        "https://api.tarmoto.app.evil.example/api/v1/roads/tiles/1/1/1.mvt?layers=quality",
      ),
    ).toBe(false);
    // Other backend routes are not tile routes.
    expect(re.test(`${API}/api/v1/users/me`)).toBe(false);
  });

  it("leaves the never-clamped surface layer un-stamped", () => {
    // The personal road map reads `layers=surface` (#1279). Those bytes are
    // identical for every requester, so a per-rider, per-rotation token in the
    // URL would take them out of shared CDN reuse for nothing.
    const re = new RegExp(pattern);

    expect(re.test(`${API}/api/v1/roads/tiles/13/1/1.mvt?layers=surface`)).toBe(
      false,
    );
    expect(re.test(`${API}/api/v1/roads/tiles/13/1/1.mvt?layers=hazards`)).toBe(
      false,
    );
  });
});

describe("authHeadersForTileUrl", () => {
  it("carries the bearer on a backend tile URL", () => {
    expect(
      authHeadersForTileUrl(
        `${API}/api/v1/roads/tiles/16/35000/22000.mvt?layers=quality`,
        TOKEN,
        API,
      ),
    ).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it.each([
    ["the basemap style", "https://tiles.openfreemap.org/styles/liberty"],
    [
      "basemap tiles",
      "https://tiles.openfreemap.org/planet/16/35000/22000.pbf",
    ],
    [
      "a foreign URL containing our tile base",
      `https://evil.example/proxy?to=${API}/api/v1/roads/tiles/16/1/1.mvt`,
    ],
    [
      "a look-alike host",
      "https://api.tarmoto.app.evil.example/api/v1/roads/tiles/16/1/1.mvt",
    ],
    ["an on-disk offline tile", "file:///docs/offline-tiles/r1/16/1/1.mvt"],
  ])("sends no bearer to %s", (_label, url) => {
    expect(authHeadersForTileUrl(url, TOKEN, API)).toEqual({});
  });

  it("sends nothing at all when signed out", () => {
    // Anonymous downloads are the correct free-tier behaviour, not an error.
    expect(
      authHeadersForTileUrl(`${API}/api/v1/roads/tiles/16/1/1.mvt`, null, API),
    ).toEqual({});
    expect(
      authHeadersForTileUrl(`${API}/api/v1/roads/tiles/16/1/1.mvt`, "", API),
    ).toEqual({});
  });
});
