import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import { FSQ_POI_IMPORT, PoiImportService } from './poi-import.service.js';
import { FsqPoiImportSource } from './poi-import-source.js';
import { fsqImportConfig, poiImportConfig } from './poi-import.config.js';
import { PoiDatabaseModule } from './poi-database.module.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 *
 * The bulk importer runs as two `PoiImportService` instances (#869): the
 * default provider is OSM (`poiImportConfig` + the strategy's OSM default), and
 * `FSQ_POI_IMPORT` is a second instance bound to `fsqImportConfig` +
 * `FsqPoiImportSource`. Both are exported so the CLI + jobs processor can drive
 * each source.
 */
@Module({
  imports: [
    ConfigModule.forFeature(poiImportConfig),
    ConfigModule.forFeature(fsqImportConfig),
    PoiDatabaseModule,
  ],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportService,
    {
      provide: FSQ_POI_IMPORT,
      useFactory: (
        dataSource: DataSource,
        config: ConfigType<typeof fsqImportConfig>,
      ) => new PoiImportService(dataSource, config, new FsqPoiImportSource()),
      inject: [getDataSourceToken('poi'), fsqImportConfig.KEY],
    },
  ],
  exports: [PoiService, PoiImportService, FSQ_POI_IMPORT],
})
export class PoiModule {}
