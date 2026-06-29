import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiImportService } from './poi-import.service.js';
import { poiImportConfig } from './poi-import.config.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 *
 * `PoiImportService` (the offline-store import, #745) is exported so the
 * jobs module's scheduled processor can drive it.
 */
@Module({
  imports: [
    ConfigModule.forFeature(poiImportConfig),
    TypeOrmModule.forFeature([Poi]),
  ],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
    PoiImportService,
  ],
  exports: [PoiService, PoiImportService],
})
export class PoiModule {}
