import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SurfaceReading } from '../../entities/surface-reading.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideTagEvent } from '../../entities/ride-tag-event.entity.js';
import { AccountModule } from '../account/index.js';
import { SensorController } from './sensor.controller.js';
import { SensorService } from './sensor.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SurfaceReading,
      RoadSegment,
      Ride,
      RideStats,
      RideTagEvent,
    ]),
    AccountModule,
  ],
  controllers: [SensorController],
  providers: [SensorService],
  exports: [SensorService],
})
export class SensorModule {}
