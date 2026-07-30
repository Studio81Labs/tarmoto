import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
import { resolvePublicBaseUrl as sharedResolvePublicBaseUrl } from '../../common/public-base-url.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { RequireFeature } from '../features/require-feature.decorator.js';
import { HazardsService } from './hazards.service.js';
import { CreateHazardDto } from './dto/create-hazard.dto.js';
import { QueryHazardsDto } from './dto/query-hazards.dto.js';
import { RouteHazardsDto } from './dto/route-hazards.dto.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';
import { FeatureLimitExceededDto } from '../features/dto/feature-limit-exceeded.dto.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';
import { HazardPhotoExpiredDto } from './dto/hazard-photo-expired.dto.js';
import {
  HAZARD_PHOTO_PATH_PREFIX,
  HazardPhotoUploadResponseDto,
  MAX_HAZARD_PHOTO_BYTES,
  isAllowedHazardPhotoUrl,
} from './dto/hazard-photo.dto.js';

@ApiTags('hazards')
@Controller('hazards')
export class HazardsController {
  constructor(
    private readonly hazardsService: HazardsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the public origin to embed in the URL we hand back from
   * `POST /hazards/photos`. The returned URL round-trips through
   * `CreateHazardDto.photo_url`, so it MUST pass
   * `isAllowedHazardPhotoUrl` under the current `NODE_ENV`,
   * AND match the trusted-origin set the service uses to classify a
   * URL as "managed", otherwise the cleanup-on-dismiss guards
   * silently no-op even though uploads look successful.
   *
   * Mirrors the review-photo controller's resolver — both surfaces
   * share `resolvePublicBaseUrl` for the env-var-vs-request fallback,
   * then probe their own path prefix to catch prod misconfigs that
   * the shared helper alone can't surface (e.g. `http://api...` set
   * in production).
   */
  private resolvePublicBaseUrl(req: express.Request): string {
    const baseUrl = sharedResolvePublicBaseUrl(req, this.config, {
      feature: 'Hazard photo uploads',
    });

    if (
      !isAllowedHazardPhotoUrl(`${baseUrl}${HAZARD_PHOTO_PATH_PREFIX}probe`)
    ) {
      throw new InternalServerErrorException(
        'Hazard photo uploads are misconfigured: TARMOTO_PUBLIC_BASE_URL ' +
          'must be an https URL in production. See docs/process/runbook.md.',
      );
    }
    return baseUrl;
  }

  @Get()
  @ApiOperation({ summary: 'Get active hazards in area' })
  @ApiResponse({ status: 200, type: [HazardResponseDto] })
  async findNearby(
    @Query() query: QueryHazardsDto,
  ): Promise<HazardResponseDto[]> {
    return this.hazardsService.findNearby(query);
  }

  @Post('photos')
  @UseGuards(AuthGuard, FeatureGuard)
  @RequireFeature('hazard_reporting')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_HAZARD_PHOTO_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a photo for a hazard report',
    description:
      `Accepts a single image file (JPEG, PNG, or WebP) up to ` +
      `${Math.round(
        MAX_HAZARD_PHOTO_BYTES / (1024 * 1024),
      )} MB. Returns the URL to submit on POST /hazards under the ` +
      `\`photo_url\` field. Splitting upload from create lets the ` +
      `mobile offline queue retry just the JSON submit on a network ` +
      `drop without re-uploading the bytes.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, type: HazardPhotoUploadResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid file type or empty body' })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'The `hazard_reporting` operator kill switch is `force_off` — the photo ' +
      'upload is blocked (not just `POST /hazards`) so a shutdown also stops ' +
      'the multipart buffering + image write during an abuse incident.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many photos awaiting a report — the caller is at the per-user ' +
      'pending-upload quota. Attach or discard existing uploads first.',
  })
  async uploadPhoto(
    @Req() req: express.Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<HazardPhotoUploadResponseDto> {
    if (!file) {
      throw new BadRequestException('A photo file is required');
    }
    const publicBaseUrl = this.resolvePublicBaseUrl(req);
    return this.hazardsService.uploadPhoto(
      req.user!.userId,
      file,
      publicBaseUrl,
    );
  }

  @Post()
  @UseGuards(AuthGuard, FeatureGuard)
  @RequireFeature('hazard_reporting')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiExtraModels(FeatureForbiddenDto, FeatureLimitExceededDto)
  @ApiOperation({ summary: 'Report a hazard' })
  @ApiResponse({ status: 201, type: HazardResponseDto })
  @ApiResponse({
    status: 403,
    description:
      'Two distinct shapes: (a) the `hazard_reporting` operator kill switch is ' +
      '`force_off` — the plain forbidden envelope (`Feature unavailable: ' +
      'hazard_reporting`, no machine fields); or (b) the caller is at their ' +
      '`hazard_reports_per_day` cap (anti-abuse rate limit, same for all tiers; ' +
      'an operator can set it to 0 as a reporting kill switch) — ' +
      '`FeatureLimitExceededDto` carrying `code: "FEATURE_LIMIT_EXCEEDED"`, ' +
      '`feature: "hazard_reports_per_day"`, `limit`, and `current`. ' +
      'Discriminate on the presence of `code`.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(FeatureForbiddenDto) },
        { $ref: getSchemaPath(FeatureLimitExceededDto) },
      ],
    },
  })
  @ApiResponse({
    status: 409,
    type: HazardPhotoExpiredDto,
    description:
      'The submitted `photo_url` refers to a managed upload the orphan sweep ' +
      'already reclaimed (the report was queued past the 24h grace window) — ' +
      '`HazardPhotoExpiredDto` carrying `code: "HAZARD_PHOTO_EXPIRED"`. The ' +
      'client must re-upload from its retained local photo and resubmit.',
  })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateHazardDto,
  ): Promise<HazardResponseDto> {
    return this.hazardsService.create(req.user!.userId, dto);
  }

  @Post(':hazardId/confirm')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a hazard is still present' })
  @ApiResponse({ status: 200, type: HazardResponseDto })
  @ApiResponse({ status: 404, description: 'Hazard not found' })
  async confirm(
    @Req() req: express.Request,
    @Param('hazardId', ParseUUIDPipe) hazardId: string,
  ): Promise<HazardResponseDto> {
    return this.hazardsService.confirm(hazardId, req.user!.userId);
  }

  @Post(':hazardId/dismiss')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report hazard is no longer present' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Hazard not found' })
  async dismiss(
    @Param('hazardId', ParseUUIDPipe) hazardId: string,
  ): Promise<void> {
    return this.hazardsService.dismiss(hazardId);
  }

  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get hazards along a route' })
  @ApiResponse({ status: 200, type: [HazardResponseDto] })
  async findAlongRoute(
    @Body() dto: RouteHazardsDto,
  ): Promise<HazardResponseDto[]> {
    return this.hazardsService.findAlongRoute(dto);
  }
}
