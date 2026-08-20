import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';
import { FeatureKillSwitchGuard } from '../features/feature-kill-switch.guard.js';
import { RequireFeatureKillSwitch } from '../features/require-feature-kill-switch.decorator.js';
import { RouteCollectionsService } from './route-collections.service.js';
import {
  AddRouteCollectionItemDto,
  CreateRouteCollectionDto,
  ReorderRouteCollectionItemsDto,
  RouteCollectionDetailDto,
  RouteCollectionFollowResponseDto,
  RouteCollectionItemResponseDto,
  RouteCollectionLibraryResponseDto,
  RouteCollectionListResponseDto,
  RouteCollectionPreviewResponseDto,
  RouteCollectionDiscoverResponseDto,
  UpdateRouteCollectionDto,
} from './dto/route-collection.dto.js';

@ApiTags('route-collections')
@Controller('collections')
export class RouteCollectionsController {
  constructor(
    private readonly routeCollectionsService: RouteCollectionsService,
  ) {}

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's own route collections (US-56)" })
  @ApiResponse({ status: 200, type: RouteCollectionListResponseDto })
  async listMine(
    @Req() req: express.Request,
  ): Promise<RouteCollectionListResponseDto> {
    return this.routeCollectionsService.listMine(req.user!.userId);
  }

  @Get('me/library')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "List the caller's owned and followed collections in one payload (US-56 follow/save).",
  })
  @ApiResponse({ status: 200, type: RouteCollectionLibraryResponseDto })
  async listLibrary(
    @Req() req: express.Request,
  ): Promise<RouteCollectionLibraryResponseDto> {
    return this.routeCollectionsService.listLibrary(req.user!.userId);
  }

  // Literal `discover` segment — declared before the `:id` route so it isn't
  // captured as a collection id. Optional auth personalises `viewer_is_following`.
  @Get('discover')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Browse public collections (search + popularity ranked)',
  })
  @ApiResponse({ status: 200, type: RouteCollectionDiscoverResponseDto })
  async discover(
    @Req() req: express.Request,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<RouteCollectionDiscoverResponseDto> {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : NaN;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : NaN;
    return this.routeCollectionsService.listDiscover(
      req.user?.userId ?? null,
      q,
      Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 48)
        : 12,
      // Upper-bound the offset so an unauthenticated caller can't force an
      // arbitrarily deep (expensive) OFFSET scan, matching the rides feed cap.
      Number.isFinite(parsedOffset)
        ? Math.min(Math.max(parsedOffset, 0), 10_000)
        : 0,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new route collection' })
  @ApiResponse({ status: 201, type: RouteCollectionDetailDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateRouteCollectionDto,
  ): Promise<RouteCollectionDetailDto> {
    return this.routeCollectionsService.create(req.user!.userId, dto);
  }

  // community_access operator kill (#1207): closes the anonymous API read
  // the companion's server gate on /community/collections/shared/[slug]
  // cannot cover. FeatureKillSwitchGuard runs FIRST — the switch is global,
  // so a killed feature skips the optional bearer-token verification
  // entirely (OptionalAuthGuard never rejects, so order changes no
  // outcome, only the work done).
  @Get('by-slug/:slug')
  @UseGuards(FeatureKillSwitchGuard, OptionalAuthGuard)
  @RequireFeatureKillSwitch('community_access')
  @ApiOperation({
    summary:
      'Read an unlisted/public collection by its slug (auth optional). Personalises `viewer_is_following` / `viewer_is_owner` when a valid Bearer token is supplied.',
  })
  @ApiResponse({ status: 200, type: RouteCollectionDetailDto })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'community_access is force_off (operator moderation kill). Body is the ' +
      'forbidden envelope carrying `feature: "community_access"` and ' +
      '`scope: "global"` — a temporary shutdown, so keep the link.',
  })
  @ApiResponse({ status: 404, description: 'Collection not found or private' })
  async getBySlug(
    @Req() req: express.Request,
    @Param('slug') slug: string,
  ): Promise<RouteCollectionDetailDto> {
    return this.routeCollectionsService.getBySlug(
      slug,
      req.user?.userId ?? null,
    );
  }

  // community_access operator kill (#1207): same gate as the parent
  // `by-slug/:slug` route — the preview serves per-item geometries, the
  // exact content a moderation kill exists to pull.
  @Get('by-slug/:slug/preview')
  @UseGuards(FeatureKillSwitchGuard)
  @RequireFeatureKillSwitch('community_access')
  @ApiOperation({
    summary:
      'Map preview geometries (simplified polylines) for the items in a public/unlisted collection. No auth — visibility gating mirrors `/collections/by-slug/:slug`.',
  })
  @ApiResponse({ status: 200, type: RouteCollectionPreviewResponseDto })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'community_access is force_off (operator moderation kill). Body is the ' +
      'forbidden envelope carrying `feature: "community_access"` and ' +
      '`scope: "global"` — a temporary shutdown, so keep the link.',
  })
  @ApiResponse({ status: 404, description: 'Collection not found or private' })
  async getPreviewBySlug(
    @Param('slug') slug: string,
  ): Promise<RouteCollectionPreviewResponseDto> {
    return this.routeCollectionsService.getPreviewBySlug(slug);
  }

  @Get(':id/preview')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Map preview geometries (simplified polylines) for the items in a collection the caller owns — any visibility, including private. Powers the owner detail-page route thumbnails. Non-owners use `/collections/by-slug/:slug/preview`.',
  })
  @ApiResponse({ status: 200, type: RouteCollectionPreviewResponseDto })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async getPreviewOwned(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RouteCollectionPreviewResponseDto> {
    return this.routeCollectionsService.getPreviewOwned(req.user!.userId, id);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Read a collection the caller owns. Non-owners must use `/collections/by-slug/:slug`.',
  })
  @ApiResponse({ status: 200, type: RouteCollectionDetailDto })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async getOwned(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RouteCollectionDetailDto> {
    return this.routeCollectionsService.getOwned(req.user!.userId, id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update collection metadata (owner only)' })
  @ApiResponse({ status: 200, type: RouteCollectionDetailDto })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async update(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRouteCollectionDto,
  ): Promise<RouteCollectionDetailDto> {
    return this.routeCollectionsService.update(req.user!.userId, id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a collection (owner only)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async delete(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.routeCollectionsService.delete(req.user!.userId, id);
  }

  @Post(':id/items')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Add a ride to a collection (owner only). Duplicate adds return the existing row.',
  })
  @ApiResponse({ status: 201, type: RouteCollectionItemResponseDto })
  @ApiResponse({
    status: 400,
    description: 'ride_id must be a valid UUID',
  })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async addItem(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddRouteCollectionItemDto,
  ): Promise<RouteCollectionItemResponseDto> {
    return this.routeCollectionsService.addItem(req.user!.userId, id, dto);
  }

  @Patch(':id/items/reorder')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reorder all items in a collection (owner only). Send the full list of item ids in the desired order.',
  })
  @ApiResponse({ status: 200, type: RouteCollectionDetailDto })
  @ApiResponse({
    status: 400,
    description:
      'item_ids does not match the current item set (missing, extras, or duplicates)',
  })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Collection not found' })
  async reorderItems(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderRouteCollectionItemsDto,
  ): Promise<RouteCollectionDetailDto> {
    return this.routeCollectionsService.reorderItems(req.user!.userId, id, dto);
  }

  @Delete(':id/items/:itemId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an item from a collection (owner only)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Collection or item not found' })
  async removeItem(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    await this.routeCollectionsService.removeItem(req.user!.userId, id, itemId);
  }

  @Post(':id/follow')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Follow a collection so it appears in the caller's library (idempotent).",
  })
  @ApiResponse({ status: 201, type: RouteCollectionFollowResponseDto })
  @ApiResponse({
    status: 400,
    description: 'You cannot follow your own collection',
  })
  @ApiResponse({ status: 404, description: 'Collection not found or private' })
  async follow(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RouteCollectionFollowResponseDto> {
    return this.routeCollectionsService.follow(req.user!.userId, id);
  }

  @Delete(':id/follow')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unfollow a collection (idempotent).' })
  @ApiResponse({ status: 204 })
  async unfollow(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.routeCollectionsService.unfollow(req.user!.userId, id);
  }
}
