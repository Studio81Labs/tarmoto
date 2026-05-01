import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from '../../entities/ride.entity.js';
import { RideStats } from '../../entities/ride-stats.entity.js';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { AccountModule } from '../account/index.js';
import { RidesController } from './rides.controller.js';
import { RidesService } from './rides.service.js';
import { GpxService } from './gpx.service.js';
import { CsvService } from './csv.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, RideStats, RideSegment, SharedRide]),
    AccountModule,
  ],
  controllers: [RidesController],
  providers: [RidesService, GpxService, CsvService],
  exports: [RidesService, GpxService, CsvService],
})
export class RidesModule {}
