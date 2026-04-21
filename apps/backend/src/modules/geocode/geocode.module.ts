import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeocodeController } from './geocode.controller.js';
import { GeocodeService } from './geocode.service.js';
import { GEOCODE_PROVIDER } from './geocode-provider.interface.js';
import { NominatimProvider } from './providers/nominatim.provider.js';

/**
 * Geocoding module with a pluggable provider. Swap Nominatim out by
 * replacing the `GEOCODE_PROVIDER` useClass below with another
 * `GeocodeProvider` implementation (e.g. Mapbox, Pelias). See ADR-0002
 * for the provider choice.
 */
@Module({
  imports: [ConfigModule],
  controllers: [GeocodeController],
  providers: [
    { provide: GEOCODE_PROVIDER, useClass: NominatimProvider },
    GeocodeService,
  ],
  exports: [GeocodeService],
})
export class GeocodeModule {}
