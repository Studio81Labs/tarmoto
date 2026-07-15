import "dotenv/config";
import { DataSource } from "typeorm";
import { Poi } from "./entities/poi.entity.js";
import { PoiImportRun } from "./entities/poi-import-run.entity.js";
import { POI_MIGRATIONS } from "./migrations/index.js";

// CLI DataSource for the separate POI database (ADR 0007). Used by
// `pnpm db:migrate:poi`. The migration list is the shared `POI_MIGRATIONS`.
export const PoiDataSource = new DataSource({
  type: "postgres",
  host: process.env.TARMOTO_POI_DATABASE_HOST || "localhost",
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || "5434", 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || "tarmoto_poi",
  username: process.env.TARMOTO_POI_DATABASE_USER || "tarmoto",
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || "tarmoto",
  entities: [Poi, PoiImportRun],
  migrations: [...POI_MIGRATIONS],
  migrationsTransactionMode: "none",
  synchronize: false,
});
