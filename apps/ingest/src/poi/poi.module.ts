import { Module } from "@nestjs/common";
import { ConfigModule, type ConfigType } from "@nestjs/config";
import { getDataSourceToken, TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PoiImportRun } from "@tarmoto/poi-db";
import { FsqPoiImportSource } from "@tarmoto/ingest";
import {
  FSQ_POI_IMPORT,
  POI_IMPORT_SOURCES,
  PoiImportService,
} from "./poi-import.service.js";
import { PoiImportRunRecorder } from "./poi-import-run.recorder.js";
import { fsqImportConfig, poiImportConfig } from "./poi-import.config.js";
import { PoiDatabaseModule } from "./poi-database.module.js";

/**
 * The import-ENGINE half of the backend's old `PoiModule` (T5): the two
 * `PoiImportService` instances (OSM default + `FSQ_POI_IMPORT`), the
 * `POI_IMPORT_SOURCES` registry the weekly dispatcher fans out over, and the
 * `PoiImportRunRecorder` — moved wholly into apps/ingest, which now owns the
 * POI DB (`PoiDatabaseModule`, `migrationsRun: true`).
 *
 * The reader-only pieces (`PoiController`, `PoiService`, `PoiStoreService`,
 * `OverpassPoiProvider`, `PoiImportAdminService`) stay in the backend — they
 * serve the live `/poi` read path and the admin front-door, neither of which
 * belongs to the ingestion engine.
 */
@Module({
  imports: [
    ConfigModule.forFeature(poiImportConfig),
    ConfigModule.forFeature(fsqImportConfig),
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], "poi"),
  ],
  providers: [
    PoiImportService,
    PoiImportRunRecorder,
    {
      provide: FSQ_POI_IMPORT,
      useFactory: (
        dataSource: DataSource,
        config: ConfigType<typeof fsqImportConfig>,
      ) => new PoiImportService(dataSource, config, new FsqPoiImportSource()),
      inject: [getDataSourceToken("poi"), fsqImportConfig.KEY],
    },
    {
      // The ordered import-source registry the weekly dispatcher iterates. OSM
      // first (the primary source), then FSQ; append future sources here.
      provide: POI_IMPORT_SOURCES,
      useFactory: (osm: PoiImportService, fsq: PoiImportService) => [osm, fsq],
      inject: [PoiImportService, FSQ_POI_IMPORT],
    },
  ],
  exports: [
    PoiImportService,
    FSQ_POI_IMPORT,
    POI_IMPORT_SOURCES,
    PoiImportRunRecorder,
  ],
})
export class PoiModule {}
