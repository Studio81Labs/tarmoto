import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Challenge } from '../../entities/challenge.entity.js';
import { ChallengeEntry } from '../../entities/challenge-entry.entity.js';
import { ChallengesController } from './challenges.controller.js';
import { ChallengesService } from './challenges.service.js';
import { FeaturesModule } from '../features/features.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Challenge, ChallengeEntry]),
    FeaturesModule,
  ],
  controllers: [ChallengesController],
  providers: [ChallengesService],
  exports: [ChallengesService],
})
export class ChallengesModule {}
