import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { redisConfig } from '../../config/redis.config.js';
import { Ride } from '../../entities/ride.entity.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [
    ConfigModule.forFeature(redisConfig),
    TypeOrmModule.forFeature([Ride]),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
