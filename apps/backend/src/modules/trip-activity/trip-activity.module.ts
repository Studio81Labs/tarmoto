import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripActivity } from '../../entities/trip-activity.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsModule } from '../events/events.module.js';
import { PushModule } from '../push/index.js';
import { TripActivityController } from './trip-activity.controller.js';
import { TripActivityService } from './trip-activity.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripActivity, TripMember, User]),
    EventsModule,
    PushModule,
  ],
  controllers: [TripActivityController],
  providers: [TripActivityService],
  exports: [TripActivityService],
})
export class TripActivityModule {}
