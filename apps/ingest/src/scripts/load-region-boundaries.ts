import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { bootstrapScriptContext } from "./bootstrap-script-context.js";
import { DEFAULT_REGIONS } from "@tarmoto/ingest";

interface RegionFeature {
  code: string;
  geometry: unknown;
}

/** Upsert one polygon per feature. Idempotent; ON CONFLICT keeps imported_at so
 *  an already-imported region stays covered across a re-load. Returns the count. */
export async function loadRegionBoundaries(
  ds: DataSource,
  features: readonly RegionFeature[],
): Promise<number> {
  for (const f of features) {
    if (!/^[A-Z]{2}$/.test(f.code)) {
      throw new Error(
        `Region boundary code must be a 2-letter ISO code: ${f.code}`,
      );
    }
    await ds.query(
      `INSERT INTO "poi_import_regions" ("code", "geom")
       VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
       ON CONFLICT ("code") DO UPDATE SET "geom" = EXCLUDED."geom"`,
      [f.code, JSON.stringify(f.geometry)],
    );
  }
  return features.length;
}

function readAsset(): RegionFeature[] {
  // __dirname at runtime is <repo>/apps/backend/dist/scripts/ (this project
  // compiles to CommonJS — see export-openapi.ts for the same pattern). The
  // asset is copied to dist/assets at build (Step 6), mirroring the src layout.
  const path = join(
    __dirname,
    "..",
    "assets",
    "import-region-boundaries.geojson",
  );
  const fc = JSON.parse(readFileSync(path, "utf8")) as {
    features: { properties: { code: string }; geometry: unknown }[];
  };
  return fc.features.map((f) => ({
    code: f.properties.code,
    geometry: f.geometry,
  }));
}

async function main(): Promise<void> {
  const features = readAsset();
  const targets = new Set(DEFAULT_REGIONS.map((r) => r.code));
  const present = new Set(features.map((f) => f.code));
  const missing = [...targets].filter((c) => !present.has(c));
  if (missing.length) {
    throw new Error(
      `Boundary asset missing target regions: ${missing.join(", ")}`,
    );
  }
  const app = await bootstrapScriptContext();
  try {
    const ds = app.get<DataSource>(getDataSourceToken("poi"));
    const n = await loadRegionBoundaries(ds, features);
    console.log(`Loaded ${n} region boundary polygons.`);
  } finally {
    await app.close();
  }
}

// Run as a CLI only (not when imported by the spec).
if (process.argv[1] && process.argv[1].endsWith("load-region-boundaries.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
