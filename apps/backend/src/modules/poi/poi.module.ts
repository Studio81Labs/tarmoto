import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import { PoiImportService } from './poi-import.service.js';
import { poiImportConfig } from './poi-import.config.js';
import { PoiDatabaseModule } from './poi-database.module.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 *
 * `PoiImportService` (the offline-store import, #745) is exported so the
 * jobs module's scheduled processor can drive it.
 */
@Module({
  imports: [ConfigModule.forFeature(poiImportConfig), PoiDatabaseModule],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiStoreService,
    PoiImportService,
  ],
  exports: [PoiService, PoiImportService],
})
export class PoiModule {}
