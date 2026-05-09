import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RideSegment } from '../../entities/ride-segment.entity.js';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { AccountModule } from '../account/account.module.js';
import { ExplorationController } from './exploration.controller.js';
import { ExplorationService } from './exploration.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([RideSegment, RoadSegment, Ride]),
    AccountModule,
  ],
  controllers: [ExplorationController],
  providers: [ExplorationService],
  exports: [ExplorationService],
})
export class ExplorationModule {}
