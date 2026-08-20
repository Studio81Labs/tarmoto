import {
  Controller,
  Get,
  Param,
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
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { TilesService } from './tiles.service.js';
import { TileParamsDto, TileQueryDto } from './dto/tile-params.dto.js';

@ApiTags('tiles')
@Controller('roads/tiles')
// Vector tile fetches are bursty (map pan/zoom): a single user easily
// requests 50+ tiles per viewport change. Raise the per-IP limit from the
// default 60/min to 600/min — generous for real usage while still bounding
// abuse via tile enumeration scrapes.
@Throttle({ default: { ttl: 60_000, limit: 600 } })
export class TilesController {
  constructor(private readonly tilesService: TilesService) {}

  // OptionalAuthGuard, not AuthGuard: tiles must stay anonymous-readable (the
  // map tab is public on both clients and MapLibre sources send no bearer),
  // but a request that DOES carry one resolves its own `road_quality_max_zoom`
  // so the quality layer can be withheld beyond the cap (#1108). No
  // `@ApiBearerAuth` — same as the other optional-auth read
  // (`GET /roads/:segmentId/reviews`): the route is documented as public.
  @Get(':z/:x/:y.mvt')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Get vector map tile with road quality overlay',
    description:
      'The quality layer is subject to the road_quality_max_zoom ' +
      'entitlement (#1108): beyond the requester’s resolved cap the ' +
      'tile is served without it (layers=quality yields 204). Anonymous ' +
      'requests resolve the free-tier cap; a bearer resolves the ' +
      'caller’s own. The surface and hazard layers are never clamped.',
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

    const userId = req.user?.userId ?? null;
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
