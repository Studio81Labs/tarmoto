import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { redisConfig } from '../../config/redis.config.js';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { GroupRide } from '../../entities/group-ride.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [
    ConfigModule.forFeature(redisConfig),
    TypeOrmModule.forFeature([Ride, TripMember, GroupRide, GroupRideMember]),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
