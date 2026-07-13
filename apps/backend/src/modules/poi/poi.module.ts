import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import {
  FSQ_POI_IMPORT,
  POI_IMPORT_SOURCES,
  PoiImportService,
} from './poi-import.service.js';
import { FsqPoiImportSource } from './poi-import-source.js';
import { fsqImportConfig, poiImportConfig } from './poi-import.config.js';
import { PoiDatabaseModule } from './poi-database.module.js';
import { PoiImportRun } from '../../entities/poi-import-run.entity.js';
import { PoiImportRunRecorder } from './poi-import-run.recorder.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 *
 * The bulk importer runs as two `PoiImportService` instances (#869): the
 * default provider is OSM (`poiImportConfig` + the strategy's OSM default), and
 * `FSQ_POI_IMPORT` is a second instance bound to `fsqImportConfig` +
 * `FsqPoiImportSource`. Both are exported so the CLI + jobs processor can drive
 * each source, and `POI_IMPORT_SOURCES` bundles them (in order) as the registry
 * the weekly dispatcher fans out over.
 */
@Module({
  imports: [
    ConfigModule.forFeature(poiImportConfig),
    ConfigModule.forFeature(fsqImportConfig),
    PoiDatabaseModule,
    TypeOrmModule.forFeature([PoiImportRun], 'poi'),
  ],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportService,
    PoiImportRunRecorder,
    {
      provide: FSQ_POI_IMPORT,
      useFactory: (
        dataSource: DataSource,
        config: ConfigType<typeof fsqImportConfig>,
      ) => new PoiImportService(dataSource, config, new FsqPoiImportSource()),
      inject: [getDataSourceToken('poi'), fsqImportConfig.KEY],
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
    PoiService,
    PoiImportService,
    FSQ_POI_IMPORT,
    POI_IMPORT_SOURCES,
    PoiImportRunRecorder,
  ],
})
export class PoiModule {}
