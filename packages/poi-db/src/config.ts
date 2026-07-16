import { registerAs } from "@nestjs/config";

// Separate PostGIS instance for POIs (ADR 0007). Mirrors databaseConfig but
// with the TARMOTO_POI_DATABASE_* prefix and a distinct local default port
// (5434) so it doesn't collide with the app DB on 5433.
export const poiDatabaseConfig = registerAs("poiDatabase", () => ({
  host: process.env.TARMOTO_POI_DATABASE_HOST || "localhost",
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || "5434", 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || "tarmoto_poi",
  username: process.env.TARMOTO_POI_DATABASE_USER || "tarmoto",
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || "tarmoto",
}));
