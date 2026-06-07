import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
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
import { FollowersService } from './followers.service.js';
import {
  FollowUserResponseDto,
  FollowerDto,
  FollowingDto,
  FeedQueryDto,
  FeedRideDto,
  SuggestedRiderDto,
} from './dto/followers.dto.js';

@ApiTags('followers')
@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class FollowersController {
  constructor(private readonly followersService: FollowersService) {}

  @Post('users/:userId/follow')
  @ApiOperation({ summary: 'Follow a user' })
  @ApiResponse({ status: 201, type: FollowUserResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot follow yourself' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Already following' })
  async follow(
    @Req() req: express.Request,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<FollowUserResponseDto> {
    return this.followersService.follow(req.user!.userId, userId);
  }

  @Delete('users/:userId/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unfollow a user' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Not following this user' })
  async unfollow(
    @Req() req: express.Request,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.followersService.unfollow(req.user!.userId, userId);
  }

  // Two-segment literal path — declared before the `users/:userId/...`
  // routes so "suggestions" isn't captured as a userId.
  @Get('users/suggestions')
  @ApiOperation({ summary: 'Riders the caller might want to follow' })
  @ApiResponse({ status: 200, type: [SuggestedRiderDto] })
  async suggestions(
    @Req() req: express.Request,
    @Query('limit') limit?: string,
  ): Promise<SuggestedRiderDto[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : NaN;
    const safeLimit = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 20)
      : 6;
    return this.followersService.getSuggestions(req.user!.userId, safeLimit);
  }

  @Get('users/:userId/followers')
  @ApiOperation({ summary: "List a user's followers" })
  @ApiResponse({ status: 200, type: [FollowerDto] })
  async listFollowers(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<FollowerDto[]> {
    return this.followersService.listFollowers(userId);
  }

  @Get('users/:userId/following')
  @ApiOperation({ summary: 'List who a user is following' })
  @ApiResponse({ status: 200, type: [FollowingDto] })
  async listFollowing(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<FollowingDto[]> {
    return this.followersService.listFollowing(userId);
  }

  @Get('feed/rides')
  @ApiOperation({ summary: 'Get ride feed from followed riders' })
  @ApiResponse({ status: 200, type: [FeedRideDto] })
  async getFeed(
    @Req() req: express.Request,
    @Query() query: FeedQueryDto,
  ): Promise<FeedRideDto[]> {
    return this.followersService.getFeed(
      req.user!.userId,
      query.lat,
      query.lng,
      query.radius_km,
      query.limit,
    );
  }
}
