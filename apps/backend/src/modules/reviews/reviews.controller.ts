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
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { ReviewsService } from './reviews.service.js';
import {
  CreateReviewDto,
  MAX_REVIEW_PHOTO_BYTES,
  MAX_REVIEW_PHOTOS,
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
   * `isAllowedReviewPhotoUrl` under the current `TARMOTO_NODE_ENV` —
   * otherwise the upload-then-submit flow would 400 on the submit step
   * even though the upload succeeded.
   *
   * `TARMOTO_PUBLIC_BASE_URL` is the source of truth (already used by
   * data-export's signed download URLs). When unset, we fall back to
   * `req.protocol://req.get('host')` for local dev — this only matches
   * `isAllowedReviewPhotoUrl` because loopback http is allowed outside
   * production. In a TLS-terminating-proxy production deploy with
   * `TARMOTO_TRUST_PROXY_HOPS=0` (the default), `req.protocol` is
   * `http`, so the fallback would emit `http://api.example.com/...`
   * URLs and the create/update DTO would reject them. Failing fast
   * here with a 500 surfaces the misconfiguration to the operator
   * instead of letting the upload look successful.
   */
  private resolvePublicBaseUrl(req: express.Request): string {
    const configured = this.config
      .get<string>('TARMOTO_PUBLIC_BASE_URL')
      ?.trim();
    const baseUrl =
      configured && configured.length > 0
        ? configured.replace(/\/$/, '')
        : `${req.protocol}://${req.get('host')}`;

    // The probe URL has to share the path prefix the upload endpoint
    // actually emits — `isAllowedReviewPhotoUrl` parses with the URL
    // constructor, so a base ending in `/foo` plus a leading `/uploads/`
    // would still parse cleanly; we just need to confirm protocol +
    // host.
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

  @Post(':segmentId/reviews/photos')
  @UseGuards(AuthGuard)
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
