import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { User } from '../../entities/user.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { PushModule } from '../push/index.js';
import { FollowersController } from './followers.controller.js';
import { FollowersService } from './followers.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserFollow, User, SharedRide]),
    PushModule,
  ],
  controllers: [FollowersController],
  providers: [FollowersService],
  exports: [FollowersService],
})
export class FollowersModule {}
