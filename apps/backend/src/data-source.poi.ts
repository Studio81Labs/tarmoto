import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Poi } from './entities/poi.entity.js';
import { AddPois1787000000000 } from './migrations-poi/1787000000000-AddPois.js';
import { AddPoiDecisionSupportFields1793000000000 } from './migrations-poi/1793000000000-AddPoiDecisionSupportFields.js';
import { AddPoiDeactivatedAt1798000000000 } from './migrations-poi/1798000000000-AddPoiDeactivatedAt.js';
import { AddPoiGeographyIndex1799000000000 } from './migrations-poi/1799000000000-AddPoiGeographyIndex.js';
import { AddPoiImportRegions1800000000000 } from './migrations-poi/1800000000000-AddPoiImportRegions.js';

// CLI DataSource for the separate POI database (ADR 0007). Used by
// `pnpm db:migrate:poi`. Keep the migrations array in sync with
// `poi-database.module.ts` (runtime `migrationsRun`).
export const PoiDataSource = new DataSource({
  type: 'postgres',
  host: process.env.TARMOTO_POI_DATABASE_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_POI_DATABASE_PORT || '5434', 10),
  database: process.env.TARMOTO_POI_DATABASE_NAME || 'tarmoto_poi',
  username: process.env.TARMOTO_POI_DATABASE_USER || 'tarmoto',
  password: process.env.TARMOTO_POI_DATABASE_PASSWORD || 'tarmoto',
  entities: [Poi],
  migrations: [
    AddPois1787000000000,
    AddPoiDecisionSupportFields1793000000000,
    AddPoiDeactivatedAt1798000000000,
    AddPoiGeographyIndex1799000000000,
    AddPoiImportRegions1800000000000,
  ],
  // `AddPoiGeographyIndex` builds its index `CONCURRENTLY`, which can't run in a
  // transaction; every POI migration is a single Postgres-atomic multi-statement
  // query, so running migrations untransacted here loses nothing. Keep in sync
  // with `poi-database.module.ts`.
  migrationsTransactionMode: 'none',
  synchronize: false,
});
