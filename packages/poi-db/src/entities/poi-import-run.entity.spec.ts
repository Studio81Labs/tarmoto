import { getMetadataArgsStorage } from "typeorm";
import { PoiImportRun } from "./poi-import-run.entity.js";

describe("PoiImportRun entity", () => {
  it("maps to the poi_import_runs table with the expected columns", () => {
    const tables = getMetadataArgsStorage().tables;
    const table = tables.find((t) => t.target === PoiImportRun);
    expect(table?.name).toBe("poi_import_runs");

    const cols = getMetadataArgsStorage()
      .columns.filter((c) => c.target === PoiImportRun)
      .map((c) => c.propertyName);
    for (const name of [
      "id",
      "source",
      "region_code",
      "status",
      "trigger",
      "fetched",
      "upserted",
      "tombstoned",
      "skip_reason",
      "error",
      "job_id",
      "started_at",
      "finished_at",
    ]) {
      expect(cols).toContain(name);
    }
  });
});
