import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  InternalServerErrorException,
  Param,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import * as express from 'express';
import { resolvePublicBaseUrl as sharedResolvePublicBaseUrl } from '../../common/public-base-url.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { SystemSwitchGuard } from '../features/system-switch.guard.js';
import { RequireSystemSwitch } from '../features/require-system-switch.decorator.js';
import { ReviewsService } from './reviews.service.js';
import {
  CreateReviewDto,
  MAX_MY_REVIEW_VOTES,
  MAX_REVIEW_PHOTO_BYTES,
  MAX_REVIEW_PHOTOS,
  MyReviewVoteDto,
  ReviewPhotosResponseDto,
  ReviewResponseDto,
  ReviewVoteDto,
  ReviewVoteResultDto,
  isAllowedReviewPhotoUrl,
  REVIEW_PHOTO_PATH_PREFIX,
} from './dto/review.dto.js';

@ApiTags('reviews')
@Controller('roads')
export class ReviewsController {
  constructor(
    private readonly reviewsService: ReviewsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the public origin to embed in the URLs we hand back from
   * `POST :segmentId/reviews/photos`. The returned URLs round-trip
   * through `CreateReviewDto.photos`, so they MUST pass
   * `isAllowedReviewPhotoUrl` under the current `NODE_ENV` —
   * AND match the trusted-origin set the service uses to classify a
   * URL as "managed", otherwise the cascade-delete and ownership
   * guards silently no-op even though uploads look successful.
   *
   * Delegates the env-var-vs-request fallback (and the production
   * hard-requirement) to the shared `resolvePublicBaseUrl` helper
   * so the rule stays in lockstep across review-photo, avatar, and
   * data-export download paths. The probe-URL check below is
   * review-photo-specific — it confirms the resolved origin still
   * passes `isAllowedReviewPhotoUrl`, catching prod misconfigs like
   * `http://api.example.com` that the shared helper otherwise
   * wouldn't reject.
   */
  private resolvePublicBaseUrl(req: express.Request): string {
    const baseUrl = sharedResolvePublicBaseUrl(req, this.config, {
      feature: 'Review photo uploads',
    });

    // The probe URL has to share the path prefix the upload endpoint
    // actually emits — `isAllowedReviewPhotoUrl` parses with the URL
    // constructor, so a base ending in `/foo` plus a leading `/uploads/`
    // would still parse cleanly; we just need to confirm protocol +
    // host. Catches bad TARMOTO_PUBLIC_BASE_URL values too (e.g.
    // someone sets `http://api.example.com` in prod by mistake).
    if (
      !isAllowedReviewPhotoUrl(`${baseUrl}${REVIEW_PHOTO_PATH_PREFIX}probe`)
    ) {
      throw new InternalServerErrorException(
        'Review photo uploads are misconfigured: TARMOTO_PUBLIC_BASE_URL ' +
          'must be an https URL in production. See docs/process/runbook.md.',
      );
    }
    return baseUrl;
  }

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

  // AuthGuard runs BEFORE SystemSwitchGuard so an unauthenticated request is
  // rejected (401) without the `feature_states` read the switch guard would do
  // — no DB amplification and no 503-vs-401 switch-state leak for anonymous
  // probes. Both guards still run in the guard phase (before `FilesInterceptor`),
  // so when `sys_poi_ratings` is off an authenticated request is 503'd BEFORE
  // Multer parses and buffers the photo payload — the kill switch still sheds
  // that upload load during a spam incident. The service-level gate in
  // `uploadPhotos` stays as the authoritative guarantee.
  @Post(':segmentId/reviews/photos')
  @UseGuards(AuthGuard, SystemSwitchGuard)
  @RequireSystemSwitch('sys_poi_ratings')
  @ApiBearerAuth()
  @UseInterceptors(
    FilesInterceptor('files', MAX_REVIEW_PHOTOS, {
      limits: { fileSize: MAX_REVIEW_PHOTO_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload photos for a road review',
    description:
      `Accepts up to ${MAX_REVIEW_PHOTOS} image files (JPEG, PNG, or WebP) ` +
      `at ${Math.round(
        MAX_REVIEW_PHOTO_BYTES / (1024 * 1024),
      )} MB each. Returns the URLs to submit on POST/PUT ` +
      `/roads/:segmentId/reviews under the \`photos\` field.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          maxItems: MAX_REVIEW_PHOTOS,
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: ReviewPhotosResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid file type or empty body' })
  @ApiResponse({ status: 404, description: 'Road segment not found' })
  async uploadPhotos(
    @Req() req: express.Request,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<ReviewPhotosResponseDto> {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one photo file is required');
    }
    const publicBaseUrl = this.resolvePublicBaseUrl(req);
    return this.reviewsService.uploadPhotos(
      req.user!.userId,
      segmentId,
      files,
      publicBaseUrl,
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

  // Deliberately ungated by `sys_poi_ratings` (#1177): this is the discovery
  // path for the vote-withdrawal DELETE below, which stays open during a pause
  // so the kill switch never traps user content. Every field is the caller's
  // own data or segment map data — no aggregates, no other rider's content —
  // in either switch state (see `ReviewsService.listMyVotes`).
  @Get('reviews/votes/mine')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List your own helpful / not-helpful votes on road reviews',
    description:
      `Newest first, capped at the most recent ${MAX_MY_REVIEW_VOTES}. ` +
      'Available even while reviews are temporarily paused, so a vote can ' +
      'always be withdrawn via DELETE /roads/reviews/:reviewId/vote. ' +
      'Contains only your own vote data plus road labels — never aggregate ' +
      'counts or another rider’s content.',
  })
  @ApiResponse({ status: 200, type: [MyReviewVoteDto] })
  async listMyVotes(@Req() req: express.Request): Promise<MyReviewVoteDto[]> {
    return this.reviewsService.listMyVotes(req.user!.userId);
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
