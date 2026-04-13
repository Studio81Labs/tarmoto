import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FunZone } from '../../entities/fun-zone.entity.js';
import { RoadsController } from './roads.controller.js';
import { RoadsService } from './roads.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RoadSegment, FunZone])],
  controllers: [RoadsController],
  providers: [RoadsService],
  exports: [RoadsService],
})
export class RoadsModule {}
