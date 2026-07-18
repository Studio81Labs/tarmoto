import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MapillaryService } from './mapillary.service.js';
import { STREET_IMAGERY_PROVIDER } from './mapillary-provider.interface.js';
import { MapillaryGraphProvider } from './providers/mapillary-graph.provider.js';
import { FeaturesModule } from '../features/features.module.js';

/**
 * Street-level imagery module with a pluggable provider. Swap Mapillary out by
 * replacing STREET_IMAGERY_PROVIDER's `useClass` with another
 * StreetImageryProvider. See ADR-0009 for the provider choice + licensing.
 * Imports FeaturesModule so MapillaryService can gate itself behind the
 * `sys_mapillary_previews` operator kill switch.
 */
@Module({
  imports: [ConfigModule, FeaturesModule],
  providers: [
    { provide: STREET_IMAGERY_PROVIDER, useClass: MapillaryGraphProvider },
    MapillaryService,
  ],
  exports: [MapillaryService],
})
export class MapillaryModule {}
