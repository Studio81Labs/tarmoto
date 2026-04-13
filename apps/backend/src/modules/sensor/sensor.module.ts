import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { SensorController } from './sensor.controller.js';
import { SensorService } from './sensor.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SurfaceReading, RoadSegment])],
  controllers: [SensorController],
  providers: [SensorService],
  exports: [SensorService],
})
export class SensorModule {}
