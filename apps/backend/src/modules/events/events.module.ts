import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { GroupRide } from '../../entities/group-ride.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { FeaturesModule } from '../features/features.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, TripMember, GroupRide, GroupRideMember]),
    FeaturesModule,
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
