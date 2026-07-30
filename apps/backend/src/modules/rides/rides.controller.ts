import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProduces,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { RequireFeature } from '../features/require-feature.decorator.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';
import { RidesService } from './rides.service.js';
import { GpxService } from './gpx.service.js';
import { StartRideDto } from './dto/start-ride.dto.js';
import { ListRidesDto } from './dto/list-rides.dto.js';
import { RenameRideDto } from './dto/rename-ride.dto.js';
import { RideStatsDto } from './dto/ride-stats.dto.js';
import { RideBreakdownDto } from './dto/ride-breakdown.dto.js';
import {
  RideResponseDto,
  RideSummaryDto,
  RideDetailDto,
  RideListResponseDto,
  RideTracksResponseDto,
} from './dto/ride-response.dto.js';

@ApiTags('rides')
@Controller('rides')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class RidesController {
  constructor(
    private readonly ridesService: RidesService,
    private readonly gpxService: GpxService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List user's rides" })
  @ApiResponse({ status: 200, type: RideListResponseDto })
  async list(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideListResponseDto> {
    return this.ridesService.list(req.user!.userId, query);
  }

  @Post('start')
  @ApiOperation({ summary: 'Start a new ride' })
  @ApiResponse({ status: 201, type: RideResponseDto })
  @ApiResponse({ status: 400, description: 'Already have an active ride' })
  async start(
    @Req() req: express.Request,
    @Body() dto: StartRideDto,
  ): Promise<RideResponseDto> {
    return this.ridesService.start(req.user!.userId, dto);
  }

  @Post('import')
  @UseGuards(FeatureGuard)
  @RequireFeature('gpx_import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }), // 10 MB max
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import a GPX file as a route' })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'The `gpx_import` operator kill switch is `force_off` — `FeatureGuard` ' +
      'rejects with the forbidden envelope carrying `feature: "gpx_import"` ' +
      '(`{ message: "Feature unavailable: gpx_import", feature: "gpx_import" }`).',
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
  @ApiResponse({ status: 201, type: RideSummaryDto })
  async importGpx(
    @Req() req: express.Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<RideSummaryDto> {
    if (!file) {
      throw new BadRequestException('GPX file is required');
    }
    const ride = await this.gpxService.importGpx(req.user!.userId, file.buffer);
    return this.ridesService.toSummary(ride);
  }

  // Literal bulk-export paths must be declared before the `:rideId` routes,
  // otherwise Nest matches `:rideId` first and `ParseUUIDPipe` rejects the
  // request with 400.
  @Get('export.csv')
  @ApiOperation({ summary: "Export all of the caller's rides as a CSV sheet" })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, description: 'CSV file' })
  async exportAllCsv(
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    const csv = await this.ridesService.exportAllCsv(req.user!.userId);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-rides-${stamp}.csv"`,
    );
    res.send(csv);
  }

  @Get('export.gpx')
  @UseGuards(FeatureGuard)
  @RequireFeature('gpx_export')
  @ApiOperation({
    summary:
      "Export all of the caller's rides as a multi-track GPX " +
      '(requires the gpx_export feature entitlement)',
  })
  @ApiProduces('application/gpx+xml')
  @ApiResponse({ status: 200, description: 'GPX file' })
  async exportAllGpx(
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    const gpx = await this.ridesService.exportAllGpx(req.user!.userId);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/gpx+xml');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-rides-${stamp}.gpx"`,
    );
    res.send(gpx);
  }

  @Get('tracks')
  @ApiOperation({
    summary: 'List simplified track geometries for map overlay',
  })
  @ApiResponse({ status: 200, type: RideTracksResponseDto })
  async tracks(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideTracksResponseDto> {
    return this.ridesService.getTracks(req.user!.userId, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate KPIs for a filtered set of rides' })
  @ApiResponse({ status: 200, type: RideStatsDto })
  async stats(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideStatsDto> {
    return this.ridesService.stats(req.user!.userId, query);
  }

  // Two path segments, so it can't collide with the single-segment `:rideId`
  // route below; declared next to `stats` for clarity.
  @Get('stats/breakdown')
  @ApiOperation({
    summary: 'Surface + curviness distance breakdown for a filtered set',
  })
  @ApiResponse({ status: 200, type: RideBreakdownDto })
  async breakdown(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideBreakdownDto> {
    return this.ridesService.breakdown(req.user!.userId, query);
  }

  @Patch(':rideId')
  @ApiOperation({ summary: 'Rename a ride' })
  @ApiResponse({ status: 200, type: RideSummaryDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async rename(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: RenameRideDto,
  ): Promise<RideSummaryDto> {
    return this.ridesService.rename(req.user!.userId, rideId, dto.name ?? null);
  }

  @Post(':rideId/stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop an active ride' })
  @ApiResponse({ status: 200, type: RideResponseDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async stop(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideResponseDto> {
    return this.ridesService.stop(req.user!.userId, rideId);
  }

  @Get(':rideId')
  @ApiOperation({ summary: 'Get ride details with stats' })
  @ApiResponse({ status: 200, type: RideDetailDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async getDetail(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideDetailDto> {
    return this.ridesService.getDetail(req.user!.userId, rideId);
  }

  @Get(':rideId/gpx')
  // Same entitlement as the bulk export.gpx above — without it, a
  // force_off / free-tier user could reconstruct the bulk export one
  // ride at a time.
  @UseGuards(FeatureGuard)
  @RequireFeature('gpx_export')
  @ApiOperation({
    summary: 'Export ride as GPX (requires the gpx_export entitlement)',
  })
  @ApiProduces('application/gpx+xml')
  @ApiResponse({ status: 200, description: 'GPX file' })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async exportGpx(
    @Req() req: express.Request,
    @Res() res: express.Response,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<void> {
    const gpx = await this.ridesService.exportGpx(req.user!.userId, rideId);
    res.set('Content-Type', 'application/gpx+xml');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-ride-${rideId}.gpx"`,
    );
    res.send(gpx);
  }

  @Get(':rideId/csv')
  @ApiOperation({ summary: 'Export ride stats as CSV' })
  @ApiProduces('text/csv')
  @ApiResponse({ status: 200, description: 'CSV file' })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async exportRideCsv(
    @Req() req: express.Request,
    @Res() res: express.Response,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<void> {
    const csv = await this.ridesService.exportRideCsv(req.user!.userId, rideId);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="tarmoto-ride-${rideId}.csv"`,
    );
    res.send(csv);
  }
}
