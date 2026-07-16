import { describe, it, expect } from "vitest";
import {
  Poi,
  PoiImportRun,
  POI_MIGRATIONS,
  PoiDataSource,
  poiDatabaseConfig,
  buildPoiTypeOrmOptions,
  CONNECT_TIMEOUT_MS,
} from "./index.js";

describe("@tarmoto/poi-db barrel", () => {
  it("re-exports every real entry point", () => {
    expect(Poi).toBeDefined();
    expect(PoiImportRun).toBeDefined();
    expect(POI_MIGRATIONS).toBeDefined();
    expect(PoiDataSource).toBeDefined();
    expect(poiDatabaseConfig).toBeDefined();
    expect(buildPoiTypeOrmOptions).toBeDefined();
    expect(CONNECT_TIMEOUT_MS).toBeDefined();
    expect(Array.isArray(POI_MIGRATIONS)).toBe(true);
    expect(POI_MIGRATIONS.length).toBeGreaterThan(0);
  });
});
