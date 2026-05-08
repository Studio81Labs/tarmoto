import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bike } from '../../entities/bike.entity.js';
import { BikesController } from './bikes.controller.js';
import { BikesService } from './bikes.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Bike])],
  controllers: [BikesController],
  providers: [BikesService],
  // Exported so RidesModule can resolve the rider's active bike when
  // a `/rides/start` request arrives without a `bike_id` payload.
  exports: [BikesService],
})
export class BikesModule {}
