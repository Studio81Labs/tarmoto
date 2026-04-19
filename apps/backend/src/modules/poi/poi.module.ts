import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { POI_PROVIDER } from './poi-provider.interface.js';
import { OverpassPoiProvider } from './providers/overpass.provider.js';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';

/**
 * POI module with pluggable provider.
 * Swap the Overpass implementation out by replacing the POI_PROVIDER
 * useClass below with another PoiProvider (e.g. Booking.com, Mapbox POI).
 */
@Module({
  imports: [ConfigModule],
  controllers: [PoiController],
  providers: [
    { provide: POI_PROVIDER, useClass: OverpassPoiProvider },
    PoiService,
  ],
  exports: [PoiService],
})
export class PoiModule {}
