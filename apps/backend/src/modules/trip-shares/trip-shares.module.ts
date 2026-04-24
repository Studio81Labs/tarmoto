import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripShare } from '../../entities/trip-share.entity.js';
import { TripSharesController } from './trip-shares.controller.js';
import { TripSharesService } from './trip-shares.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([TripShare])],
  controllers: [TripSharesController],
  providers: [TripSharesService],
  exports: [TripSharesService],
})
export class TripSharesModule {}
