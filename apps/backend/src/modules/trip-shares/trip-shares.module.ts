import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { Trip } from '../../entities/trip.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { TripActivityModule } from '../trip-activity/index.js';
import { TripSharesController } from './trip-shares.controller.js';
import { TripSharesService } from './trip-shares.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripShare, Trip, TripMember]),
    TripActivityModule,
  ],
  controllers: [TripSharesController],
  providers: [TripSharesService],
  exports: [TripSharesService],
})
export class TripSharesModule {}
