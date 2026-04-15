import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommuteRoute } from '../../entities/commute-route.entity.js';
import { Ride } from '../../entities/ride.entity.js';
import { CommuteController } from './commute.controller.js';
import { CommuteService } from './commute.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([CommuteRoute, Ride])],
  controllers: [CommuteController],
  providers: [CommuteService],
  exports: [CommuteService],
})
export class CommuteModule {}
