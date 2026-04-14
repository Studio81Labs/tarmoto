import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { EventsModule } from '../events/index.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserContact]), EventsModule],
  controllers: [SafetyController],
  providers: [SafetyService],
})
export class SafetyModule {}
