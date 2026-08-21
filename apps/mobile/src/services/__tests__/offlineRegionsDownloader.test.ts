/**
 * The RNFS tile downloader's credential handling (#1279).
 *
 * Offline packs cache quality tiles to z16. Without identity on those requests
 * the backend resolves the ANONYMOUS free cap, so a pro rider's pack would be
 * permanently free-capped from z13 up — on disk, invisibly, until they deleted
 * and re-downloaded it. `react-native-fs` is mocked because the adapter is the
 * one part of the module that touches it.
 */

// CommonJS shape (no `__esModule`/`default`): `createRNFSDownloader` reaches
// for the module with a bare `require`, exactly as the real CJS package is
// consumed at runtime.
jest.mock("react-native-fs", () => ({
  downloadFile: jest.fn(),
  unlink: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
  stat: jest.fn(),
  DocumentDirectoryPath: "/docs",
}));

import RNFS from "react-native-fs";
import { createRNFSDownloader, tileUrl } from "../offlineRegions";

const API = "https://api.tarmoto.app";
const downloadFile = RNFS.downloadFile as unknown as jest.Mock;
const unlink = RNFS.unlink as unknown as jest.Mock;

const succeed = () =>
  downloadFile.mockReturnValue({
    promise: Promise.resolve({ statusCode: 200, bytesWritten: 1024 }),
  });

const optionsOf = (call: number) =>
  downloadFile.mock.calls[call]![0] as {
    fromUrl: string;
    headers?: Record<string, string>;
  };

describe("createRNFSDownloader (#1279)", () => {
  beforeEach(() => {
    downloadFile.mockReset();
    unlink.mockReset().mockResolvedValue(undefined);
  });

  it("sends the rider's bearer with a backend tile download", async () => {
    succeed();
    const downloader = createRNFSDownloader(
      async () => "access-token-123",
      API,
    );

    await downloader.downloadTile(
      tileUrl({ z: 16, x: 35000, y: 22000 }, API),
      "/docs/offline-tiles/r1/16/35000/22000.mvt",
    );

    expect(optionsOf(0).headers).toEqual({
      Authorization: "Bearer access-token-123",
    });
  });

  it("sends no Authorization header when signed out", async () => {
    succeed();
    const downloader = createRNFSDownloader(async () => null, API);

    await downloader.downloadTile(
      tileUrl({ z: 16, x: 35000, y: 22000 }, API),
      "/docs/offline-tiles/r1/16/35000/22000.mvt",
    );

    expect(optionsOf(0).headers).toEqual({});
  });

  it("never sends the bearer to a host we do not own", async () => {
    succeed();
    const downloader = createRNFSDownloader(
      async () => "access-token-123",
      API,
    );

    await downloader.downloadTile(
      "https://tiles.openfreemap.org/planet/16/35000/22000.pbf",
      "/docs/whatever.pbf",
    );

    expect(optionsOf(0).headers).toEqual({});
  });

  it("reads the token per tile, so a rotation mid-download is picked up", async () => {
    // A 5000-tile region runs for minutes; a token captured once at the start
    // would go stale halfway and quietly free-cap the rest of the pack.
    succeed();
    let token = "first";
    const downloader = createRNFSDownloader(async () => token, API);
    const url = tileUrl({ z: 16, x: 1, y: 1 }, API);

    await downloader.downloadTile(url, "/docs/a.mvt");
    token = "second";
    await downloader.downloadTile(url, "/docs/b.mvt");

    expect(optionsOf(0).headers).toEqual({ Authorization: "Bearer first" });
    expect(optionsOf(1).headers).toEqual({ Authorization: "Bearer second" });
  });

  it("resolves the credential through a refresh-aware getter", async () => {
    // The raw RNFS request gets none of the typed client's 401 retry, so a
    // pack that outlives the one-hour access token would otherwise finish
    // anonymously — and cache free-capped quality tiles for the rest of it.
    succeed();
    const getToken = jest.fn().mockResolvedValue("refreshed-token");
    const downloader = createRNFSDownloader(getToken, API);

    await downloader.downloadTile(
      tileUrl({ z: 16, x: 1, y: 1 }, API),
      "/docs/a.mvt",
    );

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(optionsOf(0).headers).toEqual({
      Authorization: "Bearer refreshed-token",
    });
  });

  it("never reaches the network when the credential getter refuses", async () => {
    // How the hook binds a download to its rider (#1279): the getter throws
    // once ownership has changed, and it is the adapter's FIRST await — so
    // there is no window between "still the same rider" and "fetch with this
    // bearer", and no request is issued under the wrong entitlement.
    succeed();
    const downloader = createRNFSDownloader(
      () => Promise.reject(new Error("Offline download changed rider")),
      API,
    );

    await expect(
      downloader.downloadTile(
        tileUrl({ z: 16, x: 1, y: 1 }, API),
        "/docs/a.mvt",
      ),
    ).rejects.toThrow(/changed rider/);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  describe("empty (204) tiles", () => {
    beforeEach(() => {
      downloadFile.mockReturnValue({
        promise: Promise.resolve({ statusCode: 204, bytesWritten: 0 }),
      });
    });

    it("is never persisted, so a later retry can still fetch it", async () => {
      // A zero-byte file is what `tileExists` reads as done, so persisting an
      // empty tile freezes whichever cause produced it — and a pack downloaded
      // during a credential gap would stay permanently free-capped.
      const downloader = createRNFSDownloader(async () => "tok", API);

      const bytes = await downloader.downloadTile(
        tileUrl({ z: 16, x: 1, y: 1 }, API),
        "/docs/a.mvt",
      );

      expect(bytes).toBe(0);
      expect(unlink).toHaveBeenCalledWith("/docs/a.mvt");
    });

    it("fails the tile when the bearer was sent but REJECTED", async () => {
      // A rotated secret / deleted account / clock skew is served anonymously
      // by `OptionalAuthGuard`, so the request looks fine and the tile comes
      // back clamped. The `public` directive is what gives it away.
      downloadFile.mockImplementation(
        (opts: {
          begin?: (r: { headers: Record<string, string> }) => void;
        }) => {
          opts.begin?.({ headers: { "Cache-Control": "public, max-age=300" } });
          return {
            promise: Promise.resolve({ statusCode: 204, bytesWritten: 0 }),
          };
        },
      );
      const downloader = createRNFSDownloader(async () => "stale-token", API);

      await expect(
        downloader.downloadTile(
          tileUrl({ z: 16, x: 1, y: 1 }, API),
          "/docs/a.mvt",
        ),
      ).rejects.toThrow(/not resolved for this rider/);
      expect(unlink).toHaveBeenCalledWith("/docs/a.mvt");
    });

    it("accepts an empty tile the backend DID resolve this rider for", async () => {
      // Genuinely no roads here. Failing it would make a region covering empty
      // countryside permanently un-completable.
      downloadFile.mockImplementation(
        (opts: {
          begin?: (r: { headers: Record<string, string> }) => void;
        }) => {
          opts.begin?.({
            headers: { "Cache-Control": "private, max-age=300" },
          });
          return {
            promise: Promise.resolve({ statusCode: 204, bytesWritten: 0 }),
          };
        },
      );
      const downloader = createRNFSDownloader(async () => "good-token", API);

      await expect(
        downloader.downloadTile(
          tileUrl({ z: 16, x: 1, y: 1 }, API),
          "/docs/a.mvt",
        ),
      ).resolves.toBe(0);
    });

    it("accepts an empty tile when the headers never arrived", async () => {
      // No `begin` callback: absence of evidence is not evidence of an
      // anonymous response, so preserve today's behaviour rather than failing
      // every empty tile on a missing callback.
      const downloader = createRNFSDownloader(async () => "good-token", API);

      await expect(
        downloader.downloadTile(
          tileUrl({ z: 16, x: 1, y: 1 }, API),
          "/docs/a.mvt",
        ),
      ).resolves.toBe(0);
    });

    it("fails the tile when the request carried no credential", async () => {
      // What the response cannot tell apart, the request can. Succeeding here
      // would complete the region, and only a FAILED region's UI offers Retry —
      // the rider would be stranded with a silently free-capped pack.
      const downloader = createRNFSDownloader(async () => null, API);

      await expect(
        downloader.downloadTile(
          tileUrl({ z: 16, x: 1, y: 1 }, API),
          "/docs/a.mvt",
        ),
      ).rejects.toThrow(/not resolved for this rider/);
      expect(unlink).toHaveBeenCalledWith("/docs/a.mvt");
    });
  });
});
