import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { TilesController } from './tiles.controller.js';
import { TilesService } from './tiles.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([RoadSegment])],
  controllers: [TilesController],
  providers: [TilesService],
  exports: [TilesService],
})
export class TilesModule {}
