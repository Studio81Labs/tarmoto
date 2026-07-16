import type { ConfigService } from "@nestjs/config";
import type { TypeOrmModuleOptions } from "@nestjs/typeorm";
import { Poi } from "./entities/poi.entity.js";
import { PoiImportRun } from "./entities/poi-import-run.entity.js";
import { POI_MIGRATIONS } from "./migrations/index.js";

// Bound the runtime connect attempt so a reachable-but-unresponsive POI host
// can't block boot for the OS TCP timeout. (Was CONNECT_TIMEOUT_MS in the
// backend's poi-database.module.ts; moved here with the options builder.)
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Build the POI-DB TypeORM options for a Nest app. `migrationsRun` is decided by
 * the OWNING app: apps/ingest migrates (true); the backend reads only (false).
 * `OPENAPI_EXPORT` still forces it off so `openapi:gen` never writes the POI DB
 * and its spec stays byte-identical (mirrors DatabaseModule's gate).
 */
export function buildPoiTypeOrmOptions(
  config: ConfigService,
  options: { migrationsRun: boolean },
): TypeOrmModuleOptions {
  const isOpenApiExport = process.env["OPENAPI_EXPORT"] === "true";
  const host = config.get<string>("poiDatabase.host");
  const port = config.get<number>("poiDatabase.port");
  const database = config.get<string>("poiDatabase.database");
  const username = config.get<string>("poiDatabase.username");
  const password = config.get<string>("poiDatabase.password");
  return {
    type: "postgres",
    name: "poi",
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    entities: [Poi, PoiImportRun],
    migrations: [...POI_MIGRATIONS],
    migrationsRun: options.migrationsRun && !isOpenApiExport,
    migrationsTransactionMode: "none",
    synchronize: false,
    retryAttempts: 0,
    manualInitialization: true,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    extra: { connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
  };
}
