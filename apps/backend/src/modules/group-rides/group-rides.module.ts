import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GroupRide } from '../../entities/group-ride.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsModule } from '../events/events.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { GroupRidesController } from './group-rides.controller.js';
import { GroupRidesService } from './group-rides.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([GroupRide, GroupRideMember, User]),
    EventsModule,
    FeaturesModule,
  ],
  controllers: [GroupRidesController],
  providers: [GroupRidesService],
  exports: [GroupRidesService],
})
export class GroupRidesModule {}
