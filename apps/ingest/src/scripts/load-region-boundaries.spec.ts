import { loadRegionBoundaries } from "./load-region-boundaries.js";

describe("loadRegionBoundaries", () => {
  it("upserts one row per feature with ST_GeomFromGeoJSON and ON CONFLICT keeping imported_at", async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const ds = { query } as unknown as import("typeorm").DataSource;
    const features = [
      { code: "CZ", geometry: { type: "MultiPolygon", coordinates: [] } },
      { code: "SK", geometry: { type: "MultiPolygon", coordinates: [] } },
    ];

    const n = await loadRegionBoundaries(ds, features);

    expect(n).toBe(2);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "poi_import_regions"');
    expect(sql).toContain("ST_GeomFromGeoJSON");
    expect(sql).toContain('ON CONFLICT ("code")');
    // Re-load must NOT reset imported_at.
    expect(sql).not.toContain("imported_at");
    expect(params[0]).toBe("CZ");
    expect(JSON.parse(params[1] as string)).toMatchObject({
      type: "MultiPolygon",
    });
  });

  it("rejects a feature whose code is not a 2-letter ISO code", async () => {
    const ds = { query: jest.fn() } as unknown as import("typeorm").DataSource;
    await expect(
      loadRegionBoundaries(ds, [{ code: "CZE", geometry: {} }]),
    ).rejects.toThrow(/2-letter/);
  });
});
