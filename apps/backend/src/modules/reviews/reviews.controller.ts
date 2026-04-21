import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
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
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { ReviewsService } from './reviews.service.js';
import {
  CreateReviewDto,
  ReviewResponseDto,
  ReviewVoteDto,
  ReviewVoteResultDto,
} from './dto/review.dto.js';

@ApiTags('reviews')
@Controller('roads')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get(':segmentId/reviews')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Get reviews for a road segment' })
  @ApiResponse({ status: 200, type: [ReviewResponseDto] })
  async list(
    @Req() req: express.Request,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ): Promise<ReviewResponseDto[]> {
    return this.reviewsService.listForSegment(
      segmentId,
      req.user?.userId ?? null,
    );
  }

  @Post(':segmentId/reviews')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a road review' })
  @ApiResponse({ status: 201, type: ReviewResponseDto })
  @ApiResponse({ status: 409, description: 'Already reviewed this segment' })
  async create(
    @Req() req: express.Request,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Body() dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    return this.reviewsService.create(req.user!.userId, segmentId, dto);
  }

  @Put(':segmentId/reviews')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update your review for a road segment' })
  @ApiResponse({ status: 200, type: ReviewResponseDto })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async update(
    @Req() req: express.Request,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Body() dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    return this.reviewsService.update(req.user!.userId, segmentId, dto);
  }

  @Delete(':segmentId/reviews')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your review for a road segment' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async delete(
    @Req() req: express.Request,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ): Promise<void> {
    return this.reviewsService.delete(req.user!.userId, segmentId);
  }

  @Post('reviews/:reviewId/vote')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cast or flip a helpful / not-helpful vote on a review',
  })
  @ApiResponse({ status: 200, type: ReviewVoteResultDto })
  @ApiResponse({ status: 404, description: 'Review not found' })
  @ApiResponse({ status: 409, description: 'Cannot vote on your own review' })
  async vote(
    @Req() req: express.Request,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: ReviewVoteDto,
  ): Promise<ReviewVoteResultDto> {
    return this.reviewsService.castVote(
      req.user!.userId,
      reviewId,
      dto.is_helpful,
    );
  }

  @Delete('reviews/:reviewId/vote')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw your helpful vote on a review' })
  @ApiResponse({ status: 200, type: ReviewVoteResultDto })
  @ApiResponse({ status: 404, description: 'Review not found' })
  async clearVote(
    @Req() req: express.Request,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ): Promise<ReviewVoteResultDto> {
    return this.reviewsService.clearVote(req.user!.userId, reviewId);
  }
}
