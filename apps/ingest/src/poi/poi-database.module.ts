import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { buildPoiTypeOrmOptions, poiDatabaseConfig } from "@tarmoto/poi-db";

/**
 * apps/ingest OWNS the POI schema (T5): unlike the backend's read-only
 * connector (`createPoiDataSource`, tolerate-down per ADR 0007), this app is
 * the migrator, so it must fail fast if the DB is unreachable or a migration
 * errors — there is no "boot anyway and retry in the background" path here,
 * because a migrator that silently skipped its own migrations would leave the
 * schema behind for every other consumer (including the backend's readers).
 *
 * `buildPoiTypeOrmOptions` sets `manualInitialization: true`, so Nest's
 * `TypeOrmCoreModule` returns whatever `dataSourceFactory` resolves to as-is
 * (it would otherwise call `.initialize()` again itself, which throws on an
 * already-initializing/failed attempt) — the factory here owns the single
 * `initialize()` call, which is also what runs the POI migrations
 * (`migrationsRun: true`).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: "poi",
      imports: [ConfigModule.forFeature(poiDatabaseConfig)],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPoiTypeOrmOptions(config, { migrationsRun: true }),
      dataSourceFactory: (options) => new DataSource(options!).initialize(),
    }),
  ],
})
export class PoiDatabaseModule {}
