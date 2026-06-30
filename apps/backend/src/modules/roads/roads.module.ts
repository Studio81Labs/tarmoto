import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { FunZoneRoad } from '../../entities/fun-zone-road.entity.js';
import { RoadsController } from './roads.controller.js';
import { RoadsService } from './roads.service.js';
import { FunZoneClusteringService } from './fun-zone-clustering.service.js';
import { OsmImportService } from './osm-import/osm-import.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RoadSegment, FunZone, FunZoneRoad])],
  controllers: [RoadsController],
  providers: [RoadsService, FunZoneClusteringService, OsmImportService],
  exports: [RoadsService, FunZoneClusteringService, OsmImportService],
})
export class RoadsModule {}
