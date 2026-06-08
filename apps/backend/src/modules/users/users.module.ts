import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from '../../entities/ride.entity.js';
import { SharedRide } from '../../entities/shared-ride.entity.js';
import { User } from '../../entities/user.entity.js';
import { UserBadge } from '../../entities/user-badge.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { UserFollow } from '../../entities/user-follow.entity.js';
import { StorageModule } from '../storage/index.js';
import { AccountModule } from '../account/index.js';
import { BadgesModule } from '../badges/index.js';
import { SharingModule } from '../sharing/index.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserContact,
      UserFollow,
      UserBadge,
      Ride,
      SharedRide,
    ]),
    StorageModule,
    AccountModule,
    BadgesModule,
    SharingModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
