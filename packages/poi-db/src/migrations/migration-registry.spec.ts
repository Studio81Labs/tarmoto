import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { POI_MIGRATIONS } from "./index.js";

/**
 * The POI lineage now has ONE registry — `POI_MIGRATIONS` — consumed by both the
 * runtime TypeORM factory (`buildPoiTypeOrmOptions`) and the CLI `PoiDataSource`.
 * A migration file added to this directory but left out of `POI_MIGRATIONS` would
 * silently never replay on a fresh POI DB (the #555-shaped bug the app-DB guard
 * catches). This asserts every file on disk is registered exactly once.
 */
describe("POI migration registry — every file on disk is registered once", () => {
  const migrationsDir = dirname(fileURLToPath(import.meta.url));

  const filesOnDisk = (): string[] =>
    readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".spec.ts"))
      .filter((name) => name !== "index.ts")
      .map((name) => {
        const match = name.match(/^(\d+)-(.+)\.ts$/);
        if (!match) throw new Error(`unexpected migration filename: ${name}`);
        return `${match[2]}${match[1]}`;
      })
      .sort();

  it("matches POI_MIGRATIONS against src/migrations/*.ts", () => {
    const registered = POI_MIGRATIONS.map((m) => m.name).sort();
    expect(registered).toEqual(filesOnDisk());
  });

  it("never registers a migration twice", () => {
    const names = POI_MIGRATIONS.map((m) => m.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });
});
