import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { ChallengesService } from './challenges.service.js';
import {
  ChallengeDto,
  ChallengeDetailDto,
  JoinChallengeResponseDto,
  ProgressDto,
} from './dto/challenges.dto.js';

@ApiTags('challenges')
@Controller('challenges')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class ChallengesController {
  constructor(private readonly challengesService: ChallengesService) {}

  @Get()
  @ApiOperation({ summary: 'List active challenges' })
  @ApiResponse({ status: 200, type: [ChallengeDto] })
  async listActive(): Promise<ChallengeDto[]> {
    return this.challengesService.listActive();
  }

  @Get(':challengeId')
  @ApiOperation({ summary: 'Get challenge details with leaderboard' })
  @ApiResponse({ status: 200, type: ChallengeDetailDto })
  @ApiResponse({ status: 404, description: 'Challenge not found' })
  async getDetail(
    @Req() req: express.Request,
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
  ): Promise<ChallengeDetailDto> {
    return this.challengesService.getDetail(challengeId, req.user!.userId);
  }

  @Post(':challengeId/join')
  @ApiOperation({ summary: 'Join a challenge' })
  @ApiResponse({ status: 201, type: JoinChallengeResponseDto })
  @ApiResponse({ status: 400, description: 'Challenge not active' })
  @ApiResponse({ status: 404, description: 'Challenge not found' })
  @ApiResponse({ status: 409, description: 'Already joined' })
  async join(
    @Req() req: express.Request,
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
  ): Promise<JoinChallengeResponseDto> {
    return this.challengesService.join(req.user!.userId, challengeId);
  }

  @Get(':challengeId/progress')
  @ApiOperation({ summary: 'Get your progress in a challenge' })
  @ApiResponse({ status: 200, type: ProgressDto })
  @ApiResponse({ status: 404, description: 'Not participating' })
  async getProgress(
    @Req() req: express.Request,
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
  ): Promise<ProgressDto> {
    return this.challengesService.getProgress(req.user!.userId, challengeId);
  }
}
