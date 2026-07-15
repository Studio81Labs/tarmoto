import { describe, it, expect } from "vitest";
import { buildPoiTypeOrmOptions } from "./typeorm-options.js";

const cfg = {
  get: (key: string) =>
    ({
      "poiDatabase.host": "h",
      "poiDatabase.port": 5434,
      "poiDatabase.database": "d",
      "poiDatabase.username": "u",
      "poiDatabase.password": "p",
    })[key],
} as unknown as import("@nestjs/config").ConfigService;

describe("buildPoiTypeOrmOptions", () => {
  it("runs migrations when the owner opts in and not exporting OpenAPI", () => {
    delete process.env.OPENAPI_EXPORT;
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: true }).migrationsRun,
    ).toBe(true);
  });

  it("never runs migrations when the owner opts out", () => {
    delete process.env.OPENAPI_EXPORT;
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: false }).migrationsRun,
    ).toBe(false);
  });

  it("forces migrations off during OpenAPI export even when the owner opts in", () => {
    process.env.OPENAPI_EXPORT = "true";
    expect(
      buildPoiTypeOrmOptions(cfg, { migrationsRun: true }).migrationsRun,
    ).toBe(false);
    delete process.env.OPENAPI_EXPORT;
  });
});
