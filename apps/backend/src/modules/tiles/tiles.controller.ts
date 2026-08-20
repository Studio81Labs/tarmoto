import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiProduces,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { TilesService } from './tiles.service.js';
import { TileTokenService } from './tile-token.service.js';
import { TileParamsDto, TileQueryDto } from './dto/tile-params.dto.js';
import { TileTokenResponseDto } from './dto/tile-token.dto.js';

@ApiTags('tiles')
@Controller('roads/tiles')
// Vector tile fetches are bursty (map pan/zoom): a single user easily
// requests 50+ tiles per viewport change. Raise the per-IP limit from the
// default 60/min to 600/min — generous for real usage while still bounding
// abuse via tile enumeration scrapes.
@Throttle({ default: { ttl: 60_000, limit: 600 } })
export class TilesController {
  constructor(
    private readonly tilesService: TilesService,
    private readonly tileTokens: TileTokenService,
  ) {}

  /**
   * Mint the scoped tile credential a MapLibre source appends to its tile
   * URLs (#1279). See `TileTokenService` for why the live map sources carry
   * this instead of the account bearer.
   *
   * Tighter throttle than the controller default: a client with a 15-minute
   * token mints ~4 per hour, so 30/min already leaves three orders of
   * magnitude of headroom while keeping the mint far below the 600/min tile
   * burst allowance it sits beside.
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Mint a short-lived tile credential',
    description:
      'Returns a tile-scoped token to append as the `tile_token` query ' +
      'parameter on GET /roads/tiles/:z/:x/:y.mvt, so the ' +
      'road_quality_max_zoom clamp resolves against the caller instead of ' +
      'the anonymous free tier. The token authenticates no other route.',
  })
  @ApiResponse({ status: 200, type: TileTokenResponseDto })
  async mintToken(@Req() req: express.Request): Promise<TileTokenResponseDto> {
    return this.tileTokens.issue(req.user!.userId);
  }

  // OptionalAuthGuard, not AuthGuard: tiles must stay anonymous-readable (the
  // map tab is public on both clients), but a request that carries identity
  // resolves its own `road_quality_max_zoom` so the quality layer can be
  // withheld beyond the cap (#1108). No `@ApiBearerAuth` — same as the other
  // optional-auth read (`GET /roads/:segmentId/reviews`): the route is
  // documented as public, and since #1279 its primary identity channel is the
  // `tile_token` query parameter rather than a header.
  @Get(':z/:x/:y.mvt')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Get vector map tile with road quality overlay',
    description:
      'The quality layer is subject to the road_quality_max_zoom ' +
      'entitlement (#1108): beyond the requester’s resolved cap the ' +
      'tile is served without it (layers=quality yields 204). Anonymous ' +
      'requests resolve the free-tier cap; a bearer or a `tile_token` ' +
      'resolves the caller’s own. The surface and hazard layers are ' +
      'never clamped.',
  })
  @ApiProduces('application/vnd.mapbox-vector-tile')
  @ApiResponse({ status: 200, description: 'Mapbox Vector Tile' })
  @ApiResponse({ status: 204, description: 'Empty tile (no data in area)' })
  async getTile(
    @Param() params: TileParamsDto,
    @Query() query: TileQueryDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    res.set('Access-Control-Allow-Origin', '*');

    // Two identity channels, both optional, both degrading to anonymous:
    //  - `req.user` — a bearer resolved by OptionalAuthGuard. Used by the
    //    mobile offline-pack downloader, which makes plain HTTP requests
    //    where a per-request header is available and safer than a URL.
    //  - `tile_token` — the scoped query credential the live MapLibre sources
    //    carry on both clients (#1279); see `TileTokenService` for why a
    //    header is not workable there.
    // The bearer wins when both are present: it is the stronger credential and
    // resolving it costs nothing extra (the guard already verified it).
    const userId =
      req.user?.userId ??
      (await this.tileTokens.resolveUserId(query.tile_token));
    const tile = await this.tilesService.getTile(
      params.z,
      params.x,
      params.y,
      query.layers ?? 'all',
      userId,
    );

    // Apply cacheability only after generation succeeds so a transient
    // PostGIS error cannot turn a framework-generated 500 response into a
    // cacheable response. Keep the browser TTL short enough for recent
    // quality updates, while allowing the CDN to absorb cross-user viewport
    // bursts and serve stale during revalidation. `CDN-Cache-Control` is
    // intentionally separate so browser freshness does not have to match the
    // edge cache policy.
    //
    // Since #1108 tile bytes can differ by requester entitlement, so the
    // split below keeps shared caches leak-free by construction:
    //  - ANONYMOUS responses are identical for every anonymous requester
    //    (URL + global state only) and keep the shared/CDN caching that
    //    absorbs the public map's 600/min bursts.
    //  - AUTHENTICATED responses are `private` with no `CDN-Cache-Control`,
    //    so an entitled rider's above-cap quality tile can never be stored
    //    where an anonymous URL hit would receive it. Browser caching stays.
    //  - `Vary: Authorization` on every outcome (204 included) tells
    //    spec-honouring caches the bytes vary by that header. CDNs that
    //    ignore `Vary` on non-images can at worst serve a cached ANONYMOUS
    //    (clamped) tile to an authenticated rider for one edge TTL — a
    //    bounded degrade in the safe direction, never a widening.
    //
    // The `tile_token` channel (#1279) needs no `Vary` of its own: it lives in
    // the URL, so it is already part of every cache key. It still takes the
    // `private` branch — a rotating token would otherwise seed the shared
    // cache with above-cap bytes under a URL that stays reachable for the
    // token's remaining lifetime.
    if (userId !== null) {
      res.set('Cache-Control', 'private, max-age=300');
    } else {
      res.set('Cache-Control', 'public, max-age=300');
      res.set(
        'CDN-Cache-Control',
        'public, max-age=900, stale-while-revalidate=86400',
      );
    }
    res.set('Vary', 'Authorization');

    if (!tile) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
    res.send(tile);
  }
}
