import { Controller, Get, Param, Query, Res, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
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

  @Get(':z/:x/:y.mvt')
  @ApiOperation({ summary: 'Get vector map tile with road quality overlay' })
  @ApiProduces('application/vnd.mapbox-vector-tile')
  @ApiResponse({ status: 200, description: 'Mapbox Vector Tile' })
  @ApiResponse({ status: 204, description: 'Empty tile (no data in area)' })
  async getTile(
    @Param() params: TileParamsDto,
    @Query() query: TileQueryDto,
    @Res() res: express.Response,
  ): Promise<void> {
    const tile = await this.tilesService.getTile(
      params.z,
      params.x,
      params.y,
      query.layers ?? 'all',
    );

    if (!tile) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
    res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.set('Access-Control-Allow-Origin', '*');
    res.send(tile);
  }
}
