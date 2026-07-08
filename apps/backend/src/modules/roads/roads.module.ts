import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { FunZoneRoad } from '../../entities/fun-zone-road.entity.js';
import { MapillaryModule } from '../mapillary/index.js';
import { RoadsController } from './roads.controller.js';
import { RoadsService } from './roads.service.js';
import { FunZoneClusteringService } from './fun-zone-clustering.service.js';
import { OsmImportService } from './osm-import/osm-import.service.js';
import { osmImportConfig } from './osm-import/osm-import.config.js';
import { QualityConflationService } from './quality-conflation/quality-conflation.service.js';
import { qualityConflationConfig } from './quality-conflation/quality-conflation.config.js';
import { GraphHopperReimportService } from './quality-conflation/graphhopper-reimport.service.js';
import { graphhopperReimportConfig } from './quality-conflation/graphhopper-reimport.config.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([RoadSegment, FunZone, FunZoneRoad]),
    MapillaryModule,
    ConfigModule.forFeature(osmImportConfig),
    ConfigModule.forFeature(qualityConflationConfig),
    ConfigModule.forFeature(graphhopperReimportConfig),
  ],
  controllers: [RoadsController],
  providers: [
    RoadsService,
    FunZoneClusteringService,
    OsmImportService,
    QualityConflationService,
    GraphHopperReimportService,
  ],
  exports: [
    RoadsService,
    FunZoneClusteringService,
    OsmImportService,
    QualityConflationService,
    GraphHopperReimportService,
  ],
})
export class RoadsModule {}
