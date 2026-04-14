import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RidesController } from './rides.controller.js';
import { RidesService } from './rides.service.js';
import { GpxService } from './gpx.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Ride, RideStats, RideSegment])],
  controllers: [RidesController],
  providers: [RidesService, GpxService],
  exports: [RidesService, GpxService],
})
export class RidesModule {}
