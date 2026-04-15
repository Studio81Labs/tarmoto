import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Challenge } from '../../entities/challenge.entity.js';
import { ChallengeEntry } from '../../entities/challenge-entry.entity.js';
import { ChallengesController } from './challenges.controller.js';
import { ChallengesService } from './challenges.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Challenge, ChallengeEntry])],
  controllers: [ChallengesController],
  providers: [ChallengesService],
  exports: [ChallengesService],
})
export class ChallengesModule {}
